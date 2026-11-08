import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import Department from '../models/Department.js';
import Semester from '../models/Semester.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { autoEnrollSemester } from '../services/enrollmentService.js';
import { assertNoBlockers } from '../utils/blockers.js';
import Attendance from '../models/Attendance.js';
import Submission from '../models/Submission.js';
import QuizAttempt from '../models/QuizAttempt.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import Result from '../models/Result.js';
import Payment from '../models/Payment.js';
import ExaminationAdmission from '../models/ExaminationAdmission.js';
import StudentDocument from '../models/StudentDocument.js';
import Complaint from '../models/Complaint.js';
import FeeCart from '../models/FeeCart.js';
import Notification from '../models/Notification.js';
import AIConversation from '../models/AIConversation.js';
import {
  ROLES,
  DEPARTMENT_STATUS,
  CLOSED_SEMESTER_STATES,
  STUDENT_STATUS,
} from '../config/constants.js';

const populateProfile = (q) =>
  q
    .populate('user', 'name email phone isActive')
    .populate('department', 'name code')
    .populate('semester', 'name number academicYear status');

const findProfile = async (id) => {
  const profile = await populateProfile(StudentProfile.findById(id));
  if (!profile) throw ApiError.notFound('Student not found');
  return profile;
};

// A semester that a student can be placed in: same department, not completed/archived.
const getOpenSemester = async (semesterId, departmentId) => {
  const semester = await Semester.findById(semesterId);
  if (!semester) throw ApiError.notFound('Semester not found');
  if (String(semester.department) !== String(departmentId)) {
    throw ApiError.badRequest('Semester belongs to a different department');
  }
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) {
    throw ApiError.badRequest(`Cannot place students in a ${semester.status} semester`);
  }
  return semester;
};

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Creates the login (User) and the academic identity (StudentProfile) together.
export const createStudent = asyncHandler(async (req, res) => {
  const isHead = req.user.role === ROLES.UNIVERSITY_HEAD;
  const { name, email, password, phone, rollNumber, department, semester: semesterId, ...rest } = req.body;

  const deptId = isHead ? department : req.user.department; // an HOD can never pick another department
  if (!deptId) throw ApiError.badRequest('Department is required');
  assertDepartmentAccess(req.user, deptId);
  const dept = await Department.findById(deptId);
  if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Department not found or not active');

  const semester = semesterId ? await getOpenSemester(semesterId, deptId) : null;

  const user = await User.create({
    name,
    email,
    password,
    phone,
    role: ROLES.STUDENT,
    department: deptId,
    mustChangePassword: true,
  });

  let profile;
  try {
    profile = await StudentProfile.create({
      ...rest,
      user: user._id,
      rollNumber,
      department: deptId,
      semester: semester?._id || null,
      createdBy: req.user._id,
    });
  } catch (err) {
    await User.deleteOne({ _id: user._id }); // do not leave a login without a profile (for example duplicate roll number)
    throw err;
  }

  let enrollment = { enrolled: 0, courses: 0 };
  if (semester) enrollment = await autoEnrollSemester([profile], semester._id, req.user._id);

  logAudit(req, 'student.create', 'StudentProfile', profile._id, { rollNumber: profile.rollNumber });
  sendSuccess(res, { profile: await findProfile(profile._id), enrollment }, 'Student created', 201);
});

export const listStudents = asyncHandler(async (req, res) => {
  const { department, semester, section, status, search } = req.query;
  const filter = {};

  if (req.user.role === ROLES.UNIVERSITY_HEAD) {
    if (department) filter.department = department;
  } else {
    filter.department = req.user.department; // HOD: own department only
  }
  if (semester) filter.semester = semester;
  if (section) filter.section = section.toUpperCase();
  if (status) filter.status = status;

  if (search) {
    const rx = new RegExp(escapeRx(search), 'i');
    const userIds = await User.find({ role: ROLES.STUDENT, $or: [{ name: rx }, { email: rx }] }).distinct('_id');
    filter.$or = [{ user: { $in: userIds } }, { rollNumber: rx }];
  }

  const students = await populateProfile(StudentProfile.find(filter)).sort({ rollNumber: 1 }).limit(500);
  sendSuccess(res, students);
});

// The logged-in student's own profile.
export const myProfile = asyncHandler(async (req, res) => {
  const profile = await populateProfile(StudentProfile.findOne({ user: req.user._id }));
  if (!profile) throw ApiError.notFound('Your student profile has not been created yet. Please contact your department');
  sendSuccess(res, profile);
});

export const getStudent = asyncHandler(async (req, res) => {
  const profile = await findProfile(req.params.id);
  assertDepartmentAccess(req.user, profile.department._id);
  const enrollments = await CourseEnrollment.find({ student: profile.user._id })
    .populate('course', 'title code section creditHours')
    .populate('semester', 'name academicYear')
    .sort({ enrolledAt: -1 });
  sendSuccess(res, { profile, enrollments });
});

export const updateStudent = asyncHandler(async (req, res) => {
  const profile = await findProfile(req.params.id);
  assertDepartmentAccess(req.user, profile.department._id);

  const { name, phone, email, ...profileFields } = req.body;
  if (profileFields.rollNumber && (await StudentProfile.exists({ rollNumber: profileFields.rollNumber.toUpperCase(), _id: { $ne: profile._id } }))) {
    throw ApiError.conflict('Another student already has this roll number'); // checked first, so nothing is half-saved
  }
  if (name !== undefined || phone !== undefined || email !== undefined) {
    const user = await User.findById(profile.user._id);
    if (email !== undefined && email !== user.email) {
      if (await User.exists({ email, _id: { $ne: user._id } })) throw ApiError.conflict('Another account already uses this email');
      user.email = email; // the student signs in with the new email from now on
    }
    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    await user.save({ validateBeforeSave: false });
  }
  if (Object.keys(profileFields).length) {
    profile.set(profileFields);
    await profile.save();
  }
  logAudit(req, 'student.update', 'StudentProfile', profile._id, { fields: Object.keys(req.body) });
  sendSuccess(res, await findProfile(profile._id), 'Student updated');
});

export const setStudentStatus = asyncHandler(async (req, res) => {
  const profile = await findProfile(req.params.id);
  assertDepartmentAccess(req.user, profile.department._id);
  profile.status = req.body.status;
  await profile.save();

  // A suspended / withdrawn student cannot log in; a re-activated one can again.
  const canLogin = req.body.status === STUDENT_STATUS.ACTIVE;
  await User.updateOne({ _id: profile.user._id }, { isActive: canLogin });

  logAudit(req, `student.${req.body.status}`, 'StudentProfile', profile._id);
  sendSuccess(res, await findProfile(profile._id), `Student marked ${req.body.status}`);
});

// Delete a student that was added by mistake (wrong person, duplicate, typo in the roll number ...).
// Allowed only while the student has no academic or financial history. Course enrollments, the fee cart, notifications
// and AI chats are removed with the student. Otherwise the student should be suspended instead.
export const deleteStudent = asyncHandler(async (req, res) => {
  const profile = await findProfile(req.params.id);
  assertDepartmentAccess(req.user, profile.department._id);
  const uid = profile.user._id;
  const byStudent = { student: uid };

  await assertNoBlockers(
    `Student ${profile.rollNumber}`,
    [
      ['attendance records', Attendance.countDocuments({ 'records.student': uid })],
      ['assignment submissions', Submission.countDocuments(byStudent)],
      ['quiz attempts', QuizAttempt.countDocuments(byStudent)],
      ['examination marks', ExaminationMarks.countDocuments(byStudent)],
      ['results', Result.countDocuments(byStudent)],
      ['payments', Payment.countDocuments(byStudent)],
      ['examination admission requests', ExaminationAdmission.countDocuments(byStudent)],
      ['uploaded documents', StudentDocument.countDocuments(byStudent)],
      ['complaints', Complaint.countDocuments(byStudent)],
    ],
    'Suspend the student instead so the history is kept.'
  );

  await Promise.all([
    CourseEnrollment.deleteMany({ student: uid }),
    FeeCart.deleteMany({ student: uid }),
    Notification.deleteMany({ recipient: uid }),
    AIConversation.deleteMany({ user: uid }),
  ]);
  await StudentProfile.deleteOne({ _id: profile._id });
  await User.deleteOne({ _id: uid });
  logAudit(req, 'student.delete', 'StudentProfile', profile._id, { rollNumber: profile.rollNumber, name: profile.user.name });
  sendSuccess(res, null, 'Student deleted');
});

// Places (or promotes) many students into a semester and enrols them in that semester's courses.
// Old enrollments are kept as history; they are never deleted.
export const assignSemester = asyncHandler(async (req, res) => {
  const deptId = req.user.department;
  const semester = await getOpenSemester(req.body.semester, deptId);

  const profiles = await StudentProfile.find({
    _id: { $in: req.body.students },
    department: deptId,
    status: STUDENT_STATUS.ACTIVE,
  });
  if (profiles.length !== new Set(req.body.students).size) {
    throw ApiError.badRequest('Some selected students were not found, are not active, or belong to another department');
  }

  await StudentProfile.updateMany({ _id: { $in: profiles.map((p) => p._id) } }, { semester: semester._id });
  const refreshed = await StudentProfile.find({ _id: { $in: profiles.map((p) => p._id) } });
  const result = await autoEnrollSemester(refreshed, semester._id, req.user._id);

  logAudit(req, 'student.assign_semester', 'Semester', semester._id, { students: profiles.length, ...result });
  sendSuccess(res, { students: profiles.length, ...result }, 'Students placed in semester');
});

