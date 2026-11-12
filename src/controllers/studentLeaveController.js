import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import StudentLeave from '../models/StudentLeave.js';
import Attendance from '../models/Attendance.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { ROLES } from '../config/constants.js';

const key = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (k, n) => {
  const d = new Date(`${k}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Students whose APPROVED leave covers `date`. Used by the attendance sheet so a student on leave is not counted absent.
export const studentsOnLeave = async (date, studentIds) => {
  const k = key(date);
  const rows = await StudentLeave.find({ status: 'approved', fromDate: { $lte: k }, toDate: { $gte: k }, student: { $in: studentIds } }).select('student').lean();
  return new Set(rows.map((r) => String(r.student)));
};

// Attendance that was ALREADY taken for days inside an approved leave: "absent" becomes "leave".
// (Days taken later are handled by studentsOnLeave in the attendance sheet.) Present stays present.
const markLeaveInAttendance = async (leave) => {
  const from = new Date(`${leave.fromDate}T00:00:00.000Z`);
  const to = new Date(`${leave.toDate}T00:00:00.000Z`);
  const r = await Attendance.updateMany(
    { date: { $gte: from, $lte: to }, records: { $elemMatch: { student: leave.student, status: 'absent' } } },
    { $set: { 'records.$[r].status': 'leave' } },
    { arrayFilters: [{ 'r.student': leave.student, 'r.status': 'absent' }] }
  );
  return r.modifiedCount || 0;
};

// ---------- the student ----------
export const requestLeave = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id }).select('department status');
  if (!profile) throw ApiError.badRequest('Your student record was not found. Please contact your department');
  const { fromDate, toDate, type, reason } = req.body;
  const todayKey = key(new Date());
  if (fromDate < addDays(todayKey, -7)) throw ApiError.badRequest('A leave can start at most 7 days in the past');
  if (toDate > addDays(fromDate, 60)) throw ApiError.badRequest('A leave request can cover at most 60 days');
  const overlap = await StudentLeave.findOne({ student: req.user._id, status: { $in: ['pending', 'approved'] }, fromDate: { $lte: toDate }, toDate: { $gte: fromDate } });
  if (overlap) throw ApiError.conflict(`You already have a ${overlap.status} leave from ${overlap.fromDate} to ${overlap.toDate}`);

  const leave = await StudentLeave.create({ student: req.user._id, department: profile.department, fromDate, toDate, type, reason });
  const hods = await User.find({ role: ROLES.HOD, department: profile.department, isActive: true }).distinct('_id');
  await notifyUsers(hods, { title: 'Student leave request', message: `${req.user.name} asks for leave from ${fromDate} to ${toDate}: ${reason}`, type: 'leave', link: '/student-leave' });
  logAudit(req, 'student_leave.request', 'StudentLeave', leave._id, { fromDate, toDate });
  sendSuccess(res, leave, 'Leave requested. You will be told when it is decided', 201);
});

export const cancelLeave = asyncHandler(async (req, res) => {
  const leave = await StudentLeave.findOne({ _id: req.params.id, student: req.user._id });
  if (!leave) throw ApiError.notFound('Leave request not found');
  const todayKey = key(new Date());
  if (leave.status === 'pending' || (leave.status === 'approved' && leave.fromDate > todayKey)) {
    leave.status = 'cancelled';
    await leave.save();
    return sendSuccess(res, leave, 'Leave cancelled');
  }
  throw ApiError.badRequest('Only a waiting request, or an approved leave that has not started, can be cancelled');
});

// ---------- list: the student sees their own, the HOD their department, the principal everything ----------
export const listLeaves = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.STUDENT) filter.student = req.user._id;
  else if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  else if (req.query.department) filter.department = req.query.department;
  if (req.query.status) filter.status = req.query.status;

  const leaves = await StudentLeave.find(filter)
    .populate('student', 'name')
    .populate('department', 'name code')
    .populate('reviewedBy', 'name')
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const profiles = await StudentProfile.find({ user: { $in: leaves.map((l) => l.student?._id).filter(Boolean) } }).select('user rollNumber').lean();
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, leaves.map((l) => ({ ...l, rollNumber: roll.get(String(l.student?._id)) || '' })));
});

// Only the HOD of the student's department decides. The principal can see every request but not decide.
export const reviewLeave = asyncHandler(async (req, res) => {
  const leave = await StudentLeave.findById(req.params.id).populate('student', 'name');
  if (!leave) throw ApiError.notFound('Leave request not found');
  if (String(req.user.department) !== String(leave.department)) throw ApiError.forbidden('You can only decide the requests of your own department');
  if (leave.status !== 'pending') throw ApiError.conflict(`This request was already ${leave.status}`);

  leave.status = req.body.status;
  leave.reviewNote = req.body.note || '';
  leave.reviewedBy = req.user._id;
  leave.reviewedAt = new Date();
  await leave.save();

  let updated = 0;
  if (leave.status === 'approved') updated = await markLeaveInAttendance(leave);

  await notifyUsers([leave.student._id], {
    title: `Leave ${leave.status}`,
    message: `Your leave from ${leave.fromDate} to ${leave.toDate} was ${leave.status} by ${req.user.name}.${leave.reviewNote ? ` Note: ${leave.reviewNote}` : ''}`,
    type: 'leave',
    link: '/student-leave',
  });
  logAudit(req, `student_leave.${leave.status}`, 'StudentLeave', leave._id, { student: leave.student.name, attendanceSheetsUpdated: updated });
  sendSuccess(res, leave, leave.status === 'approved' ? 'Approved. The student will be marked Leave, not Absent, on those days' : 'Rejected');
});
