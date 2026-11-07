import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { enrollInCourses } from '../services/enrollmentService.js';
import { ROLES, COURSE_STATUS, ENROLLMENT_STATUS, STUDENT_STATUS, CLOSED_SEMESTER_STATES } from '../config/constants.js';

const loadCourse = async (id) => {
  const course = await Course.findById(id).populate('semester', 'status name');
  if (!course) throw ApiError.notFound('Course not found');
  return course;
};

// Teacher: only their own course. HOD: own department. Head: everything (read-only routes only).
const assertCourseAccess = (user, course) => {
  if (user.role === ROLES.TEACHER) {
    if (String(course.teacher) !== String(user._id)) throw ApiError.forbidden('This course is not assigned to you');
    return;
  }
  assertDepartmentAccess(user, course.department);
};

// Class list of a course (enrolled students with roll numbers).
export const courseStudents = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.id);
  assertCourseAccess(req.user, course);

  const enrollments = await CourseEnrollment.find({ course: course._id, status: ENROLLMENT_STATUS.ENROLLED })
    .populate('student', 'name email isActive')
    .lean();
  const profiles = await StudentProfile.find({ user: { $in: enrollments.map((e) => e.student?._id) } })
    .select('user rollNumber section status')
    .lean();
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));

  const rows = enrollments
    .filter((e) => e.student)
    .map((e) => ({
      enrollmentId: e._id,
      studentId: e.student._id,
      name: e.student.name,
      email: e.student.email,
      rollNumber: byUser.get(String(e.student._id))?.rollNumber || '',
      section: byUser.get(String(e.student._id))?.section || '',
      enrolledAt: e.enrolledAt,
    }))
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));

  sendSuccess(res, { course: { _id: course._id, code: course.code, title: course.title, section: course.section }, students: rows });
});

// HOD adds students (User ids) to a course manually, for example for electives or late joiners.
export const enrollStudents = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department);
  if (course.status !== COURSE_STATUS.ACTIVE) throw ApiError.badRequest('Only active courses accept enrollments');
  if (CLOSED_SEMESTER_STATES.includes(course.semester.status)) {
    throw ApiError.badRequest(`This course belongs to a ${course.semester.status} semester`);
  }

  const ids = [...new Set(req.body.students)];
  const profiles = await StudentProfile.find({
    user: { $in: ids },
    department: course.department,
    status: STUDENT_STATUS.ACTIVE,
  }).select('user');
  if (profiles.length !== ids.length) {
    throw ApiError.badRequest('Some students were not found, are inactive, or belong to another department');
  }

  const result = await enrollInCourses(ids, [course], req.user._id);
  logAudit(req, 'enrollment.add', 'Course', course._id, { count: result.enrolled });
  sendSuccess(res, result, 'Students enrolled');
});

// Dropping keeps the row (status = dropped) so history is preserved.
export const dropStudents = asyncHandler(async (req, res) => {
  const course = await loadCourse(req.params.id);
  assertDepartmentAccess(req.user, course.department);

  const result = await CourseEnrollment.updateMany(
    { course: course._id, student: { $in: req.body.students }, status: ENROLLMENT_STATUS.ENROLLED },
    { status: ENROLLMENT_STATUS.DROPPED, droppedAt: new Date(), droppedBy: req.user._id }
  );
  logAudit(req, 'enrollment.drop', 'Course', course._id, { count: result.modifiedCount });
  sendSuccess(res, { dropped: result.modifiedCount }, 'Students removed from course');
});

// The logged-in student's courses. By default only the current semester; ?all=true includes history.
export const myCourses = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id }).select('semester');
  const filter = { student: req.user._id, status: ENROLLMENT_STATUS.ENROLLED };
  if (req.query.all !== 'true') {
    if (!profile?.semester) return sendSuccess(res, []);
    filter.semester = profile.semester;
  }

  const enrollments = await CourseEnrollment.find(filter)
    .populate({
      path: 'course',
      select: 'title code section creditHours description outline teacher startDate endDate status',
      populate: { path: 'teacher', select: 'name email' },
    })
    .populate('semester', 'name number academicYear status')
    .sort({ enrolledAt: -1 });

  sendSuccess(res, enrollments.filter((e) => e.course));
});
