import Department from '../models/Department.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
import Attendance from '../models/Attendance.js';
import Result from '../models/Result.js';
import Payment from '../models/Payment.js';
import { asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { round2 } from '../utils/oid.js';
import { ROLES, STUDENT_STATUS, PAYMENT_STATUS, RESULT_STATUS } from '../config/constants.js';

const countBy = async (model, match, field = 'department') => {
  const rows = await model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

// University-wide (head) or own department (HOD): headcounts, attendance, pass rate and, for the head, fees collected.
export const overview = asyncHandler(async (req, res) => {
  const isHead = req.user.role === ROLES.UNIVERSITY_HEAD;
  const deptFilter = isHead ? {} : { _id: req.user.department };
  const departments = await Department.find(deptFilter).select('name code status').sort({ name: 1 }).lean();
  const inDept = isHead ? {} : { department: req.user.department };

  const [students, teachers, courses, attendance, results, fees] = await Promise.all([
    countBy(StudentProfile, { ...inDept, status: STUDENT_STATUS.ACTIVE }),
    countBy(User, { ...inDept, role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true }),
    countBy(Course, { ...inDept, status: 'active' }),
    Attendance.aggregate([
      { $match: inDept }, { $unwind: '$records' },
      { $group: { _id: '$department', total: { $sum: 1 }, attended: { $sum: { $cond: [{ $in: ['$records.status', ['present', 'leave']] }, 1, 0] } } } },
    ]),
    Result.aggregate([
      { $match: { ...inDept, status: RESULT_STATUS.PUBLISHED } },
      { $group: { _id: '$department', total: { $sum: 1 }, passed: { $sum: { $cond: [{ $eq: ['$outcome', 'pass'] }, 1, 0] } } } },
    ]),
    isHead ? Payment.aggregate([{ $match: { status: PAYMENT_STATUS.PAID } }, { $group: { _id: '$department', amount: { $sum: '$totalAmount' } } }]) : [],
  ]);
  const att = new Map(attendance.map((a) => [String(a._id), a]));
  const res2 = new Map(results.map((r) => [String(r._id), r]));
  const fee = new Map(fees.map((f) => [String(f._id), f.amount]));

  sendSuccess(res, departments.map((d) => {
    const id = String(d._id);
    return {
      department: d,
      students: students.get(id) || 0,
      teachers: teachers.get(id) || 0,
      courses: courses.get(id) || 0,
      attendancePercent: att.get(id) ? round2((att.get(id).attended / att.get(id).total) * 100) : null,
      passRate: res2.get(id) ? round2((res2.get(id).passed / res2.get(id).total) * 100) : null,
      ...(isHead ? { feesCollected: fee.get(id) || 0 } : {}),
    };
  }));
});
