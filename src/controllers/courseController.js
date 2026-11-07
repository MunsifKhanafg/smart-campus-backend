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
import { assertNoBlockers } from '../utils/blockers.js';
import { courseBlockerChecks, purgeCourse } from '../services/courseRemoval.js';
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
const validateTeacher = async (teacherId, departmentId) => {
  const teacher = await User.findById(teacherId);
  if (!teacher || !teacher.isActive || ![ROLES.TEACHER, ROLES.HOD].includes(teacher.role)) {
    throw ApiError.badRequest('Selected teacher not found or inactive');
  }
  if (String(teacher.department) !== String(departmentId)) {
    throw ApiError.badRequest('Teacher must belong to the same department as the course');
  }
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
  sendSuccess(res, courses);
});

export const getCourse = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertCourseAccess(req.user, course);
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
  if (teacher) await validateTeacher(teacher, semester.department);

  const course = await Course.create({
    ...rest,
    startDate: startDate || semester.startDate, // default to the whole semester
    endDate: endDate || semester.endDate,
    teacher: teacher || null,
    semester: semester._id,
    department: semester.department,
    createdBy: req.user._id,
  });
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
  if (req.body.teacher) await validateTeacher(req.body.teacher, course.department._id);
  // If the course is already on the timetable, its slots move to the new teacher (or the change is refused on a clash).
  if (String(previous || '') !== String(req.body.teacher || '')) await reassignCourseSlots(course, req.body.teacher);
  course.teacher = req.body.teacher;
  await course.save();

  // The new teacher is told the subject, credit hours, semester, section, student count and course contents.
  await notifyTeacherChange({ course, semesterName: course.semester?.name, previous, next: req.body.teacher });
  logAudit(req, 'course.assign_teacher', 'Course', course._id, { from: previous, to: req.body.teacher });
  sendSuccess(res, await findCourse(course._id), req.body.teacher ? 'Teacher assigned' : 'Teacher removed');
});

// Delete a course that was created by mistake. Allowed only while no teaching or exam data exists for it.
// Its timetable slots, enrollments and AI chats are removed with it. A course with real records must be archived instead.
export const deleteCourse = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);

  await assertNoBlockers(`Course ${course.code}`, courseBlockerChecks(course), 'Archive the course instead so its history is kept.');
  await purgeCourse(course);
  logAudit(req, 'course.delete', 'Course', course._id, { code: course.code, title: course.title });
  sendSuccess(res, null, 'Course deleted');
});

export const setCourseStatus = asyncHandler(async (req, res) => {
  const course = await findCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department._id);
  course.status = req.body.status;
  await course.save();
  logAudit(req, `course.${req.body.status}`, 'Course', course._id);
  sendSuccess(res, course, `Course ${req.body.status}`);
});
