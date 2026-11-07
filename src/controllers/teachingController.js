import Program from '../models/Program.js';
import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { reassignCourseSlots } from '../services/timetableService.js';
import { enrollInCourses } from '../services/enrollmentService.js';
import { notifyTeacherChange } from '../services/assignmentNotice.js';
import { normalizeCode } from '../services/curriculumService.js';
import { subjectsOf, createMissingClasses } from '../services/classService.js';
import { ROLES, COURSE_STATUS, STUDENT_STATUS, CLOSED_SEMESTER_STATES } from '../config/constants.js';

const loadSemester = async (id) => {
  const s = await Semester.findById(id).populate('department', 'name code');
  if (!s) throw ApiError.notFound('Semester not found');
  return s;
};

// ---------- The HOD's assignment board ----------
// For one semester of the HOD's department and one approved BS programme:
//   rows     = every subject of that semester of the programme, with the class(es) already created and their teacher
//   teachers = every active teacher of the department with qualification, contact details and current teaching load
// The principal may open the same board read-only.
export const board = asyncHandler(async (req, res) => {
  const semester = await loadSemester(req.query.semester);
  assertDepartmentAccess(req.user, semester.department._id);
  const deptId = semester.department._id;

  const programs = await Program.find({ department: deptId, status: 'active' }).sort({ name: 1 }).lean();
  const program = req.query.program
    ? programs.find((p) => String(p._id) === req.query.program)
    : programs.length === 1 ? programs[0] : null;
  if (req.query.program && !program) throw ApiError.notFound('Programme not found in this department');

  const subjects = subjectsOf(program, semester.number);
  const codes = subjects.map((s) => s.code);
  const [courses, teachers] = await Promise.all([
    Course.find({ semester: semester._id }).populate('teacher', 'name email').lean(),
    User.find({ department: deptId, role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true }).select('name email phone qualification role').sort({ name: 1 }).lean(),
  ]);

  const load = await Course.find({ teacher: { $in: teachers.map((t) => t._id) }, status: COURSE_STATUS.ACTIVE })
    .populate('semester', 'name number status')
    .lean();
  const open = load.filter((c) => c.semester && !CLOSED_SEMESTER_STATES.includes(c.semester.status));

  sendSuccess(res, {
    semester: { _id: semester._id, name: semester.name, number: semester.number, academicYear: semester.academicYear, status: semester.status, department: semester.department },
    programs: programs.map((p) => ({ _id: p._id, name: p.name, hasThisSemester: p.semesters.some((s) => s.number === semester.number) })),
    program: program ? { _id: program._id, name: program.name } : null,
    readOnly: req.user.role !== ROLES.HOD,
    rows: subjects.map((sub) => ({
      subject: sub,
      classes: courses
        .filter((c) => c.code === sub.code)
        .map((c) => ({ _id: c._id, section: c.section, status: c.status, teacher: c.teacher ? { _id: c.teacher._id, name: c.teacher.name } : null })),
    })),
    otherClasses: courses.filter((c) => !codes.includes(c.code)).length,
    teachers: teachers.map((t) => {
      const mine = open.filter((c) => String(c.teacher) === String(t._id));
      return {
        ...t,
        creditHours: mine.reduce((n, c) => n + (c.creditHours || 0), 0),
        assignments: mine.map((c) => ({ _id: c._id, code: c.code, title: c.title, section: c.section, creditHours: c.creditHours, semester: c.semester?.name })),
      };
    }),
  });
});

// ---------- Create ALL classes of a semester from the approved curriculum ----------
// The HOD picks a semester and a programme; every subject of that semester number becomes a class (Course) at once,
// for each requested section, without a teacher. Teachers are assigned afterwards on the same board (assignSubject below).
// Safe to run again: classes that already exist are left untouched. Students already placed in this semester and
// section are enrolled in each new class.
export const generateCourses = asyncHandler(async (req, res) => {
  const sections = [...new Set(req.body.sections)];
  const semester = await loadSemester(req.body.semester);
  assertDepartmentAccess(req.user, semester.department._id);
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) throw ApiError.badRequest(`This semester is ${semester.status}`);

  const program = await Program.findOne({ _id: req.body.program, department: semester.department._id, status: 'active' });
  if (!program) throw ApiError.notFound('Programme not found in your department');
  const subjects = subjectsOf(program, semester.number);
  if (!subjects.length) {
    throw ApiError.badRequest(`${program.name} has no subjects for semester ${semester.number}. The semester number of ${semester.name} must match a semester of the curriculum`);
  }

  const { made, enrolled } = await createMissingClasses({ semester, program, subjects, sections, userId: req.user._id });

  const total = subjects.length * sections.length;
  logAudit(req, 'teaching.generate', 'Semester', semester._id, { program: program.name, sections, created: made.length, enrolled });
  sendSuccess(
    res,
    { created: made.length, alreadyExisted: total - made.length, subjects: subjects.length, sections, studentsEnrolled: enrolled },
    made.length ? `${made.length} class(es) created from the curriculum` : 'All classes of this semester already exist',
    made.length ? 201 : 200
  );
});

// ---------- Assign (or remove) the teacher of one subject ----------
// Creates the class (Course) from the approved curriculum the first time, enrols the students of that semester and
// section, and later changes simply replace the teacher. Teacher profile, department details and semester details all read
// the same Course document, so one save updates every screen.
export const assignSubject = asyncHandler(async (req, res) => {
  const { semester: semesterId, program: programId, section } = req.body;
  const code = normalizeCode(req.body.code);
  const semester = await loadSemester(semesterId);
  assertDepartmentAccess(req.user, semester.department._id);
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) throw ApiError.badRequest(`This semester is ${semester.status}`);

  const program = await Program.findOne({ _id: programId, department: semester.department._id, status: 'active' });
  if (!program) throw ApiError.notFound('Programme not found in your department');
  const subject = subjectsOf(program, semester.number).find((s) => s.code === code);
  if (!subject) throw ApiError.badRequest(`${code} is not a subject of semester ${semester.number} of ${program.name}`);

  let teacher = null;
  if (req.body.teacher) {
    teacher = await User.findById(req.body.teacher);
    if (!teacher || !teacher.isActive || ![ROLES.TEACHER, ROLES.HOD].includes(teacher.role)) throw ApiError.badRequest('Selected teacher not found or inactive');
    if (String(teacher.department) !== String(semester.department._id)) throw ApiError.badRequest('Teacher must belong to the same department');
  }

  let course = await Course.findOne({ semester: semester._id, code: subject.code, section });
  const created = !course;
  if (created) {
    if (!teacher) throw ApiError.badRequest('This subject has no class yet, so there is no teacher to remove');
    course = new Course({
      outline: subject.outline || '', // course contents from the curriculum
      title: subject.title,
      code: subject.code,
      creditHours: subject.creditHours,
      department: semester.department._id,
      semester: semester._id,
      program: program._id,
      section,
      startDate: semester.startDate,
      endDate: semester.endDate,
      createdBy: req.user._id,
    });
  } else if (course.status === COURSE_STATUS.ARCHIVED) {
    throw ApiError.badRequest('This class is archived. Activate it from Courses first');
  }

  const previous = course.teacher ? String(course.teacher) : null;
  const next = teacher ? String(teacher._id) : null;
  if (!created && previous !== next) await reassignCourseSlots(course, teacher?._id || null); // moves timetable slots, or refuses on a clash
  course.teacher = teacher?._id || null;
  if (!course.program) course.program = program._id;
  if (!course.outline && subject.outline) course.outline = subject.outline; // contents added to the curriculum after the class was created
  await course.save();

  let enrolled = 0;
  if (created) {
    const profiles = await StudentProfile.find({ semester: semester._id, section: course.section, status: STUDENT_STATUS.ACTIVE }).select('user').lean();
    enrolled = (await enrollInCourses(profiles.map((p) => p.user), [course], req.user._id)).enrolled;
  }

  if (previous !== next) {
    await notifyTeacherChange({ course, semesterName: semester.name, previous, next }); // subject, credits, section, students and course contents
  }
  logAudit(req, 'teaching.assign', 'Course', course._id, { code: course.code, semester: semester.name, from: previous, to: next, created, enrolled });

  sendSuccess(res, {
    class: { _id: course._id, section: course.section, status: course.status, teacher: teacher ? { _id: teacher._id, name: teacher.name } : null },
    created,
    studentsEnrolled: enrolled,
  }, teacher ? (created ? 'Class created and teacher assigned' : 'Teacher assigned') : 'Teacher removed', created ? 201 : 200);
});
