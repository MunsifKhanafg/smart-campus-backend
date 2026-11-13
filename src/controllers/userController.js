import User from '../models/User.js';
import Department from '../models/Department.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { assertNoBlockers } from '../utils/blockers.js';
import { teacherDataSummary, purgeTeacher } from '../services/teacherRemoval.js';
import { teachesIn, cleanSubjects, cleanExtraDepartments } from '../services/teacherService.js';
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

  // The finance officer and the library controller belong to the whole college (no department). Only the principal gives these accesses.
  const collegeRole = [ROLES.FINANCE_OFFICER, ROLES.LIBRARY_CONTROLLER].includes(role);
  if (!isHead && collegeRole) throw ApiError.forbidden('Only the University Head can add finance officers and library controllers');

  let deptId = department;
  if (!isHead) deptId = req.user.department; // HOD is forced into their own department
  // A common-subject teacher (English, Mathematics, Islamiat...) belongs to the whole college. Only the principal can add one,
  // and a home department is optional for them (there is no "Mathematics department" to put them in).
  const collegeWide = role === ROLES.TEACHER && isHead && !!req.body.allDepartments;
  if (!collegeRole) {
    if (!deptId && !collegeWide) throw ApiError.badRequest('Choose a department, or tick "Teaches in every department" for a common-subject teacher');
    if (deptId) {
      assertDepartmentAccess(req.user, deptId);
      const dept = await Department.findById(deptId);
      if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Department not found or not active');
    }
  } else {
    deptId = undefined;
  }

  // A teacher's subjects and the other departments they also teach in (the HOD of those departments can give them classes).
  const teaching = {};
  if (role === ROLES.TEACHER) {
    teaching.subjects = cleanSubjects(req.body.subjects);
    teaching.extraDepartments = await cleanExtraDepartments(req.body.extraDepartments, deptId);
    teaching.allDepartments = collegeWide;
  } else {
    delete req.body.maxWeeklyHours; // only teachers have a weekly teaching limit
    delete req.body.allDepartments;
  }
  const user = await User.create({ ...req.body, ...teaching, department: deptId, mustChangePassword: true });
  logAudit(req, 'user.create', 'User', user._id, { role, department: deptId });
  sendSuccess(res, user, 'User created', 201);
});

export const listUsers = asyncHandler(async (req, res) => {
  const { role, department, search, includeShared } = req.query;
  const and = [];
  // The department being looked at: the principal chooses one (or none = everybody), an HOD always sees their own.
  const dept = req.user.role === ROLES.UNIVERSITY_HEAD ? department : req.user.department;
  if (dept) {
    // includeShared: also teachers of OTHER departments who are allowed to teach here (common subjects such as English)
    and.push(includeShared === 'true' ? { $or: [{ department: dept }, { extraDepartments: dept }, { allDepartments: true }] } : { department: dept });
  }
  if (role) and.push({ role });
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [{ name: rx }, { email: rx }] });
  }
  const filter = and.length ? { $and: and } : {};
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

// Delete a teacher account. Only teachers can be deleted here: an HOD must first be replaced (HOD transfer), and students are
// deleted from the Students page. A teacher that is connected to subjects or records is deleted only after the HOD / principal
// confirmed it in the window (the page sends ?force=true then). Their subjects lose the teacher, their classes leave the
// timetable, and what they wrote stays in the students' records.
const loadDeletableTeacher = async (req) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (String(user._id) === String(req.user._id)) throw ApiError.badRequest('You cannot delete your own account');
  if (user.role === ROLES.HOD) throw ApiError.badRequest('An HOD cannot be deleted. Transfer the HOD role to another teacher first');
  if (user.role !== ROLES.TEACHER) throw ApiError.badRequest('Only teachers can be deleted here. Students are deleted from the Students page');
  assertDepartmentAccess(req.user, user.department);
  return user;
};

// What the teacher is connected to. The delete window shows this before anything is removed.
export const previewTeacherDelete = asyncHandler(async (req, res) => {
  const user = await loadDeletableTeacher(req);
  sendSuccess(res, { name: user.name, ...(await teacherDataSummary(user._id)) });
});

export const deleteUser = asyncHandler(async (req, res) => {
  const user = await loadDeletableTeacher(req);
  const summary = await teacherDataSummary(user._id);
  if (summary.hasRecords && req.query.force !== 'true') {
    throw ApiError.conflict(`${user.name} is connected to records (${summary.items.map((i) => `${i.count} ${i.label}`).join(', ')}). Confirm to delete the account.`);
  }
  const { unassigned } = await purgeTeacher(user, req.user._id);
  logAudit(req, 'user.delete', 'User', user._id, {
    name: user.name, email: user.email, role: user.role, connected: Object.fromEntries(summary.items.map((i) => [i.label, i.count])),
  });
  const list = unassigned.map((c) => `${c.code} ${c.title} (${c.semester}, Section ${c.section})`);
  sendSuccess(
    res,
    { unassigned },
    list.length ? `Teacher deleted. ${list.length} subject${list.length === 1 ? ' has' : 's have'} no teacher now: ${list.join(' · ')}. Their classes stay on the timetable as "No teacher assigned". Assign a new teacher on the Courses page.` : 'Teacher deleted'
  );
});

// Full profile of one teacher/HOD for the principal (any department) or an HOD (own department only):
// contact details, qualification and every subject they teach with the number of students in it.
export const teacherProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('department', 'name code').populate('extraDepartments', 'name code');
  if (!user || ![ROLES.TEACHER, ROLES.HOD].includes(user.role)) throw ApiError.notFound('Teacher not found');
  // The HOD of a department the teacher is shared with may open the profile too (but sees only the classes of their own department).
  if (!(req.user.role === ROLES.HOD && teachesIn(user, req.user.department))) assertDepartmentAccess(req.user, user.department?._id);

  const courseFilter = { teacher: user._id };
  if (req.user.role === ROLES.HOD && String(user.department?._id) !== String(req.user.department)) courseFilter.department = req.user.department;
  const courses = await Course.find(courseFilter)
    .populate('department', 'name code')
    .populate('semester', 'name number academicYear status')
    .sort({ createdAt: -1 })
    .lean();
  const sizes = await CourseEnrollment.aggregate([
    { $match: { course: { $in: courses.map((c) => c._id) }, status: ENROLLMENT_STATUS.ENROLLED } },
    { $group: { _id: '$course', n: { $sum: 1 } } },
  ]);
  const size = new Map(sizes.map((s) => [String(s._id), s.n]));
  const rows = courses.map((c) => ({
    _id: c._id, code: c.code, title: c.title, section: c.section, creditHours: c.creditHours, weeklyClasses: c.weeklyClasses || null, department: c.department, status: c.status,
    semester: c.semester, students: size.get(String(c._id)) || 0,
  }));
  const current = rows.filter((c) => c.status === 'active' && !['completed', 'archived'].includes(c.semester?.status));
  sendSuccess(res, {
    teacher: user,
    courses: rows,
    totals: {
      courses: current.length,
      creditHours: current.reduce((s, c) => s + (c.creditHours || 0), 0),
      weeklyHours: current.reduce((s, c) => s + (c.weeklyClasses || c.creditHours || 0), 0), // classes per week, what the weekly limit is measured against
      maxWeeklyHours: user.maxWeeklyHours || null,
      students: current.reduce((s, c) => s + c.students, 0),
    },
  });
});

// Corrects a teacher's (or, for the principal, any staff member's) name, email, phone or qualification after a typing
// mistake, so nobody has to delete and re-create the account. An HOD can edit teachers of their own department only.
// Students are corrected from the Students page. The email must stay unique.
export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === ROLES.UNIVERSITY_HEAD) throw ApiError.forbidden('Use Account to change your own details');
  if (user.role === ROLES.STUDENT) throw ApiError.badRequest('Students are corrected from the Students page');
  if (req.user.role !== ROLES.UNIVERSITY_HEAD) {
    assertDepartmentAccess(req.user, user.department);
    if (user.role !== ROLES.TEACHER) throw ApiError.forbidden('An HOD can correct the details of teachers of their own department only');
  }

  const { name, email, phone, qualification, subjects, extraDepartments, maxWeeklyHours, allDepartments } = req.body;
  const changed = [];
  if (email !== undefined && email !== user.email) {
    if (await User.exists({ email, _id: { $ne: user._id } })) throw ApiError.conflict('Another account already uses this email');
    user.email = email;
    changed.push('email');
  }
  if (name !== undefined && name !== user.name) { user.name = name; changed.push('name'); }
  if (phone !== undefined && phone !== user.phone) { user.phone = phone; changed.push('phone'); }
  if (qualification !== undefined && qualification !== user.qualification) { user.qualification = qualification; changed.push('qualification'); }
  // What the person teaches, where, and how many hours a week the administrator allows (empty = no limit).
  if (subjects !== undefined) { user.subjects = cleanSubjects(subjects); changed.push('subjects'); }
  if (maxWeeklyHours !== undefined && maxWeeklyHours !== user.maxWeeklyHours) { user.maxWeeklyHours = maxWeeklyHours; changed.push('weekly hours limit'); }
  if (allDepartments !== undefined && allDepartments !== !!user.allDepartments) {
    if (!allDepartments) {
      // Switching "every department" off is refused while the teacher still has running classes outside their own permitted departments.
      const permitted = [String(user.department), ...(user.extraDepartments || []).map(String)];
      const running = await Course.find({ teacher: user._id, status: 'active' }).populate('semester', 'status').lean();
      if (running.some((c) => c.semester && !['completed', 'archived'].includes(c.semester.status) && !permitted.includes(String(c.department)))) {
        throw ApiError.conflict('This teacher still has classes in other departments. Give those classes to another teacher first');
      }
    }
    user.allDepartments = allDepartments;
    changed.push('teaches in every department');
  }
  if (extraDepartments !== undefined) {
    const next = await cleanExtraDepartments(extraDepartments, user.department);
    const removed = (user.extraDepartments || []).filter((d) => !next.some((n) => String(n) === String(d)));
    if (removed.length) {
      // A department cannot be taken away while the teacher still has running classes there.
      const running = await Course.find({ teacher: user._id, department: { $in: removed }, status: 'active' }).populate('semester', 'status').lean();
      if (running.some((c) => c.semester && !['completed', 'archived'].includes(c.semester.status))) {
        throw ApiError.conflict('This teacher still has classes in a department you are removing. Give those classes to another teacher first');
      }
    }
    user.extraDepartments = next;
    changed.push('other departments');
  }
  if (!changed.length) throw ApiError.badRequest('Nothing was changed');
  await user.save();

  logAudit(req, 'user.update', 'User', user._id, { role: user.role, fields: changed });
  sendSuccess(res, user, `Saved (${changed.join(', ')}).${changed.includes('email') ? ' The person must now sign in with the new email' : ''}`);
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

// A staff member forgot their password. The principal can set a temporary one for anybody except the principal; an HOD can do it for
// the teachers of their own department. The person must choose their own password at the next login.
export const resetPassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');
  if (user.role === ROLES.UNIVERSITY_HEAD) throw ApiError.forbidden('Use Account to change your own password');
  if (req.user.role !== ROLES.UNIVERSITY_HEAD) {
    assertDepartmentAccess(req.user, user.department);
    if (user.role !== ROLES.TEACHER) throw ApiError.forbidden('An HOD can set a temporary password for teachers of their own department only');
  }
  user.password = req.body.temporaryPassword;
  user.mustChangePassword = true;
  await user.save(); // the model hashes it and invalidates the person's open sessions
  logAudit(req, 'user.reset_password', 'User', user._id, { role: user.role });
  sendSuccess(res, null, 'Temporary password set. Give it to the person. They must choose their own password at the next login');
});
