import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { ROLES, ENROLLMENT_STATUS, COURSE_STATUS, CLOSED_SEMESTER_STATES } from '../config/constants.js';

// ONE place that answers "may this user touch this course?". Every teaching controller calls it.
//   mode 'write' : only the teacher assigned to the course (create topics, mark attendance, enter marks ...)
//   mode 'staff' : assigned teacher, HOD of the department, or the University Head (read-only views)
//   mode 'any'   : staff, plus a student who is enrolled in the course
export const getCourseFor = async (user, courseId, mode = 'staff') => {
  const course = await Course.findById(courseId).populate('semester', 'status name startDate endDate');
  if (!course) throw ApiError.notFound('Course not found');

  if (mode === 'write') {
    if (user.role !== ROLES.TEACHER || String(course.teacher) !== String(user._id)) {
      throw ApiError.forbidden('Only the teacher assigned to this course can do this');
    }
    if (course.status !== COURSE_STATUS.ACTIVE) throw ApiError.badRequest('This course is archived');
    if (CLOSED_SEMESTER_STATES.includes(course.semester?.status)) {
      throw ApiError.badRequest(`This course belongs to a ${course.semester.status} semester`);
    }
    return course;
  }

  if (user.role === ROLES.STUDENT) {
    if (mode !== 'any') throw ApiError.forbidden();
    const enrolled = await CourseEnrollment.exists({
      student: user._id,
      course: course._id,
      status: ENROLLMENT_STATUS.ENROLLED,
    });
    if (!enrolled) throw ApiError.forbidden('You are not enrolled in this course');
    return course;
  }
  if (user.role === ROLES.TEACHER) {
    if (String(course.teacher) !== String(user._id)) throw ApiError.forbidden('This course is not assigned to you');
    return course;
  }
  if (user.role === ROLES.HOD) {
    assertDepartmentAccess(user, course.department);
    return course;
  }
  if (user.role === ROLES.UNIVERSITY_HEAD) return course;
  throw ApiError.forbidden();
};

export const enrolledStudentIds = (courseId) =>
  CourseEnrollment.find({ course: courseId, status: ENROLLMENT_STATUS.ENROLLED }).distinct('student');

// Course ids a student is currently enrolled in (optionally limited to one semester).
export const studentCourseIds = (studentId, semesterId) =>
  CourseEnrollment.find({
    student: studentId,
    status: ENROLLMENT_STATUS.ENROLLED,
    ...(semesterId ? { semester: semesterId } : {}),
  }).distinct('course');
