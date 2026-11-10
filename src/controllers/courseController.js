import Course from '../models/Course.js';
import Semester from '../models/Semester.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import StudentProfile from '../models/StudentProfile.js';
import { reassignCourseSlots } from '../services/timetableService.js';
import { enrollInCourses } from '../services/enrollmentService.js';
import { notifyTeacherChange } from '../services/assignmentNotice.js';
import { fillOutline, backfillOutlines, syncFromCurriculum } from '../services/outlineService.js';
import { assertNoBlockers } from '../utils/blockers.js';
import { teachesIn, assertWithinWeeklyLimit } from '../services/teacherService.js';
import { courseDataSummary, purgeCourseDeep } from '../services/courseRemoval.js';
import { ROLES, SEMESTER_STATUS, COURSE_STATUS } from '../config/constants.js';

const populateCourse = (q) =>
  q
    .populate('department', 'name code')
    .populate('semester', 'name number academicYear status startDate endDate')
    .populate('teacher', 'name email');

const findCourse = async (id) => {
  const course = await populateCourse(Course.findById(id));
  if (!course) throw ApiError.notFound('Course not found');
  return course;
};

// A teacher may only open a course that is assigned to them. HOD/head follow department rules.
const assertCourseAccess = (user, course) => {
  if (user.role === ROLES.TEACHER) {
    if (String(course.teacher?._id || course.teacher) !== String(user._id)) {
      throw ApiError.forbidden('This course is not assigned to you');
    }
    return;
  }
  assertDepartmentAccess(user, course.department._id || course.department);
};

// The teacher must be an active teacher/HOD of the SAME department as the course.
const validateTeacher = async (teacherId, departmentId, forCourse = null) => {
  const teacher = await User.findById(teacherId);
  if (!teacher || !teacher.isActive || ![ROLES.TEACHER, ROLES.HOD].includes(teacher.role)) {
    throw ApiError.badRequest('Selected teacher not found or inactive');
  }
  if (!teachesIn(teacher, departmentId)) {
    throw ApiError.badRequest('This teacher does not work in the department of the course. Add the department under the teacher\'s "Also teaches in" list (Users > Edit)');
  }
  if (forCourse) await assertWithinWeeklyLimit(teacher, forCourse); // the weekly limit the administrator set for this teacher (none = no limit)
  return teacher;
};

// Course dates (if given) must sit inside the semester.
const assertWithinSemester = (semester, startDate, endDate) => {
  if (startDate && startDate < semester.startDate) throw ApiError.badRequest('Course cannot start before its semester');
  if (endDate && endDate > semester.endDate) throw ApiError.badRequest('Course cannot end after its semester');
};

export const listCourses = asyncHandler(async (req, res) => {
  const { department, semester, teacher, status } = req.query;
  const filter = {};

  if (req.user.role === ROLES.TEACHER) {
    filter.teacher = req.user._id; // teachers never see other people's courses
  } else if (req.user.role === ROLES.UNIVERSITY_HEAD) {
    if (department) filter.department = department;
    if (teacher) filter.teacher = teacher;
  } else {
    filter.department = req.user.department; // HOD
    if (teacher) filter.teacher = teacher;
  }
  if (semester) filter.semester = semester;
  if (status) filter.status = status;

  const courses = await populateCourse(Course.find(filter)).sort({ code: 1, section: 1 });
  if (req.user.role !== ROLES.UNIVERSITY_HEAD) await backfillOutlines(courses); // classes made before the contents existed get them now
  sendSuccess(res, courses);
});

export const getCourse = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertCourseAccess(req.user, course);
  await backfillOutlines([course]);
  sendSuccess(res, course);
});

export const createCourse = asyncHandler(async (req, res) => {
  const { semester: semesterId, teacher, startDate, endDate, ...rest } = req.body;

  const semester = await Semester.findById(semesterId);
  if (!semester) throw ApiError.notFound('Semester not found');
  assertDepartmentAccess(req.user, semester.department);
  if ([SEMESTER_STATUS.ARCHIVED, SEMESTER_STATUS.COMPLETED].includes(semester.status)) {
    throw ApiError.badRequest(`Cannot add courses to a ${semester.status} semester`);
  }
  assertWithinSemester(semester, startDate, endDate);
  if (teacher) await validateTeacher(teacher, semester.department, { code: rest.code, creditHours: rest.creditHours, weeklyClasses: rest.weeklyClasses });

  const course = await Course.create({
    ...rest,
    startDate: startDate || semester.startDate, // default to the whole semester
    endDate: endDate || semester.endDate,
    teacher: teacher || null,
    semester: semester._id,
    department: semester.department,
    createdBy: req.user._id,
  });
  if (await fillOutline(course, semester.number)) await course.save(); // course contents from the curriculum, when it has them
  // Students already placed in this semester and section join the new course automatically.
  const profiles = await StudentProfile.find({ semester: semester._id, section: course.section, status: 'active' }).select('user').lean();
  const { enrolled } = await enrollInCourses(profiles.map((p) => p.user), [course], req.user._id);

  logAudit(req, 'course.create', 'Course', course._id, { code: course.code, enrolled });
  sendSuccess(res, await findCourse(course._id), enrolled ? `Course created. ${enrolled} students enrolled automatically` : 'Course created', 201);
});

export const updateCourse = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);
  if (course.status === COURSE_STATUS.ARCHIVED) throw ApiError.badRequest('Archived courses cannot be edited');

  const semester = await Semester.findById(course.semester._id);
  assertWithinSemester(semester, req.body.startDate, req.body.endDate);

  course.set(req.body);
  await course.save();
  logAudit(req, 'course.update', 'Course', course._id, { fields: Object.keys(req.body) });
  sendSuccess(res, course, 'Course updated');
});

// Assign, change or remove (teacher: null) the teacher of a course.
export const assignTeacher = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);
  if (course.status === COURSE_STATUS.ARCHIVED) throw ApiError.badRequest('Archived courses cannot be changed');

  const previous = course.teacher?._id;
  if (req.body.teacher && String(previous || '') !== String(req.body.teacher)) await validateTeacher(req.body.teacher, course.department._id, course);
  else if (req.body.teacher) await validateTeacher(req.body.teacher, course.department._id);
  // If the course is already on the timetable, its slots move to the new teacher (or the change is refused on a clash).
  if (String(previous || '') !== String(req.body.teacher || '')) await reassignCourseSlots(course, req.body.teacher);
  course.teacher = req.body.teacher;
  await fillOutline(course, course.semester?.number); // the subject's course contents come from the curriculum automatically
  await course.save();

  // The new teacher is told the subject, credit hours, semester, section, student count and course contents.
  await notifyTeacherChange({ course, semesterName: course.semester?.name, previous, next: req.body.teacher });
  logAudit(req, 'course.assign_teacher', 'Course', course._id, { from: previous, to: req.body.teacher });
  sendSuccess(res, await findCourse(course._id), req.body.teacher ? 'Teacher assigned' : 'Teacher removed');
});

// What is inside the subject. The delete window shows this before anything is removed.
export const previewCourseDelete = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);
  sendSuccess(res, { name: `${course.code} - ${course.title}`, ...(await courseDataSummary(course)) });
});

// Delete a subject.
export const deleteCourse = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);

  const summary = await courseDataSummary(course);
  if (summary.blocked) throw ApiError.badRequest(summary.blocked);
  // A subject with attendance, assignments, quizzes ... is only deleted after the HOD confirmed it in the window
  // (the page sends ?force=true then). Without the confirmation the server refuses and says what is inside.
  if (summary.hasRecords && req.query.force !== 'true') {
    throw ApiError.conflict(`${course.code} has records (${summary.items.map((i) => `${i.count} ${i.label}`).join(', ')}). Confirm to delete it together with them.`);
  }
  await purgeCourseDeep(course);
  logAudit(req, 'course.delete', 'Course', course._id, { code: course.code, title: course.title, removed: Object.fromEntries(summary.items.map((i) => [i.label, i.count])) });
  sendSuccess(res, null, 'Course deleted');
});

// HOD: bring the official subject name and the course contents from the BS curriculum into ONE class.
// The class is matched by its code, then by its subject name. Its own contents are kept unless overwrite is true.
export const syncCurriculum = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);
  if (course.status === COURSE_STATUS.ARCHIVED) throw ApiError.badRequest('Archived courses cannot be changed');
  const result = await syncFromCurriculum(course, { overwrite: !!req.body?.overwrite });
  if (!result.matched) throw ApiError.notFound(`No subject named "${course.title}" (${course.code}) was found in the approved curriculum of this department. Check the code or the subject name.`);
  if (result.changed.length) await course.save();
  logAudit(req, 'course.sync_curriculum', 'Course', course._id, { changed: result.changed, source: result.source });
  const message = result.changed.length
    ? `Updated from the curriculum (${result.changed.join(' and ')}): ${result.source}`
    : result.hasContents
    ? 'Nothing to change. The class already has its contents (use "Replace contents" to overwrite them)'
    : `Matched with ${result.source}, but the curriculum has no course contents for this subject`;
  sendSuccess(res, await findCourse(course._id), message);
});

// HOD: do the same for every active class of one semester at once.
export const syncSemesterCurriculum = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.body.semester);
  if (!semester) throw ApiError.notFound('Semester not found');
  assertDepartmentAccess(req.user, semester.department);
  const courses = await populateCourse(Course.find({ semester: semester._id, status: COURSE_STATUS.ACTIVE }));
  const summary = { updated: 0, alreadyComplete: 0, notFound: [], noContents: [] };
  for (const course of courses) {
    const r = await syncFromCurriculum(course, { overwrite: !!req.body.overwrite });
    if (!r.matched) { summary.notFound.push(`${course.code} ${course.title}`); continue; }
    if (r.changed.length) { await course.save(); summary.updated += 1; } else summary.alreadyComplete += 1;
    if (!r.hasContents) summary.noContents.push(`${course.code} ${course.title}`);
  }
  logAudit(req, 'course.sync_curriculum_semester', 'Semester', semester._id, { updated: summary.updated, notFound: summary.notFound.length });
  sendSuccess(res, summary, `${summary.updated} class(es) updated from the curriculum`);
});

export const setCourseStatus = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);
  course.status = req.body.status;
  await course.save();
  logAudit(req, `course.${req.body.status}`, 'Course', course._id);
  sendSuccess(res, course, `Course ${req.body.status}`);
});
