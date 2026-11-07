import User from '../models/User.js';
import Department from '../models/Department.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { assertNoBlockers } from '../utils/blockers.js';
import Course from '../models/Course.js';
import Attendance from '../models/Attendance.js';
import CourseTopic from '../models/CourseTopic.js';
import Assignment from '../models/Assignment.js';
import Quiz from '../models/Quiz.js';
import Submission from '../models/Submission.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import TimetableSlot from '../models/TimetableSlot.js';
import Notification from '../models/Notification.js';
import AIConversation from '../models/AIConversation.js';
import { ROLES, DEPARTMENT_STATUS, ENROLLMENT_STATUS } from '../config/constants.js';
import CourseEnrollment from '../models/CourseEnrollment.js';

// University Head creates finance officers, teachers, students.
// An HOD can create teachers/students, but only inside their own department.
export const createUser = asyncHandler(async (req, res) => {
  const { role, department } = req.body;
  const isHead = req.user.role === ROLES.UNIVERSITY_HEAD;

  if (!isHead && role === ROLES.FINANCE_OFFICER) throw ApiError.forbidden('Only the University Head can add finance officers');

  let deptId = department;
  if (!isHead) deptId = req.user.department; // HOD is forced into their own department
  if (role !== ROLES.FINANCE_OFFICER) {
    if (!deptId) throw ApiError.badRequest('Department is required for this role');
    assertDepartmentAccess(req.user, deptId);
    const dept = await Department.findById(deptId);
    if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Department not found or not active');
  } else {
    deptId = undefined;
  }

  const user = await User.create({ ...req.body, department: deptId, mustChangePassword: true });
  logAudit(req, 'user.create', 'User', user._id, { role, department: deptId });
  sendSuccess(res, user, 'User created', 201);
});

export const listUsers = asyncHandler(async (req, res) => {
  const { role, department, search } = req.query;
  const filter = {};
  if (req.user.role === ROLES.UNIVERSITY_HEAD) {
    if (department) filter.department = department;
  } else {
    filter.department = req.user.department; // HOD sees only their department
  }
  if (role) filter.role = role;
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const users = await User.find(filter).populate('department', 'name code').sort({ name: 1 }).limit(200);
  sendSuccess(res, users);
});

export const setUserActive = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (String(user._id) === String(req.user._id)) throw ApiError.badRequest('You cannot deactivate your own account');
  if (user.role === ROLES.UNIVERSITY_HEAD) throw ApiError.forbidden('The University Head account cannot be changed here');
  if (req.user.role !== ROLES.UNIVERSITY_HEAD) {
    assertDepartmentAccess(req.user, user.department);
    if (user.role === ROLES.HOD) throw ApiError.forbidden();
  }
  user.isActive = req.body.isActive;
  await user.save({ validateBeforeSave: false });
  logAudit(req, user.isActive ? 'user.activate' : 'user.deactivate', 'User', user._id);
  sendSuccess(res, user, 'User updated');
});

// Delete a teacher that was added by mistake. Only teachers can be deleted here: an HOD must first be replaced
// (HOD transfer), and students are deleted from the Students page. A teacher with courses or teaching records is
// refused with a clear reason; deactivating the account is the safe alternative.
export const deleteUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (String(user._id) === String(req.user._id)) throw ApiError.badRequest('You cannot delete your own account');
  if (user.role === ROLES.HOD) throw ApiError.badRequest('An HOD cannot be deleted. Transfer the HOD role to another teacher first');
  if (user.role !== ROLES.TEACHER) throw ApiError.badRequest('Only teachers can be deleted here. Students are deleted from the Students page');
  assertDepartmentAccess(req.user, user.department);

  const id = user._id;
  await assertNoBlockers(
    `Teacher ${user.name}`,
    [
      ['assigned courses (remove the teacher from them first)', Course.countDocuments({ teacher: id })],
      ['timetable classes', TimetableSlot.countDocuments({ teacher: id })],
      ['attendance sheets', Attendance.countDocuments({ markedBy: id })],
      ['teaching topics', CourseTopic.countDocuments({ createdBy: id })],
      ['assignments', Assignment.countDocuments({ createdBy: id })],
      ['quizzes', Quiz.countDocuments({ createdBy: id })],
      ['graded submissions', Submission.countDocuments({ gradedBy: id })],
      ['entered examination marks', ExaminationMarks.countDocuments({ enteredBy: id })],
    ],
    'Deactivate the account instead so the records stay intact.'
  );

  await Promise.all([Notification.deleteMany({ recipient: id }), AIConversation.deleteMany({ user: id })]);
  await User.deleteOne({ _id: id });
  logAudit(req, 'user.delete', 'User', id, { name: user.name, email: user.email, role: user.role });
  sendSuccess(res, null, 'Teacher deleted');
});

// Full profile of one teacher/HOD for the principal (any department) or an HOD (own department only):
// contact details, qualification and every subject they teach with the number of students in it.
export const teacherProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('department', 'name code');
  if (!user || ![ROLES.TEACHER, ROLES.HOD].includes(user.role)) throw ApiError.notFound('Teacher not found');
  assertDepartmentAccess(req.user, user.department?._id);

  const courses = await Course.find({ teacher: user._id })
    .populate('semester', 'name number academicYear status')
    .sort({ createdAt: -1 })
    .lean();
  const sizes = await CourseEnrollment.aggregate([
    { $match: { course: { $in: courses.map((c) => c._id) }, status: ENROLLMENT_STATUS.ENROLLED } },
    { $group: { _id: '$course', n: { $sum: 1 } } },
  ]);
  const size = new Map(sizes.map((s) => [String(s._id), s.n]));
  const rows = courses.map((c) => ({
    _id: c._id, code: c.code, title: c.title, section: c.section, creditHours: c.creditHours, status: c.status,
    semester: c.semester, students: size.get(String(c._id)) || 0,
  }));
  const current = rows.filter((c) => c.status === 'active' && !['completed', 'archived'].includes(c.semester?.status));
  sendSuccess(res, {
    teacher: user,
    courses: rows,
    totals: {
      courses: current.length,
      creditHours: current.reduce((s, c) => s + (c.creditHours || 0), 0),
      students: current.reduce((s, c) => s + c.students, 0),
    },
  });
});

// The principal changes the login email of a staff member or student (for example after a typing mistake).
// The email must be unique. The principal's own account is changed from the Account page.
export const changeUserEmail = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === ROLES.UNIVERSITY_HEAD) throw ApiError.forbidden('Use Account to change your own email');
  const email = req.body.email;
  if (await User.exists({ email, _id: { $ne: user._id } })) throw ApiError.conflict('Another account already uses this email');
  const before = user.email;
  user.email = email;
  await user.save({ validateBeforeSave: true });
  logAudit(req, 'user.change_email', 'User', user._id, { role: user.role, from: before, to: email });
  sendSuccess(res, user, 'Email changed. The person must now sign in with the new email');
});

// The principal sets a temporary password for a locked-out staff member or student.
// The person must choose their own password at the next login. The principal's own account is excluded.
export const resetPassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === ROLES.UNIVERSITY_HEAD) throw ApiError.forbidden('Use Account to change your own password');
  user.password = req.body.temporaryPassword;
  user.mustChangePassword = true;
  await user.save(); // the model hashes it and invalidates the person's open sessions
  logAudit(req, 'user.reset_password', 'User', user._id, { role: user.role });
  sendSuccess(res, null, 'Temporary password set. The user must change it at the next login');
});
