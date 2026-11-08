import FeeReminder from '../models/FeeReminder.js';
import FeeNotice from '../models/FeeNotice.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { createReminder } from '../services/feeReminderService.js';
import { ROLES, FEE_NOTICE_STATUS } from '../config/constants.js';

// The HOD sees the lists of their own department only. The finance office and the principal see every department.
const scope = (user, query) => {
  const filter = {};
  if (user.role === ROLES.HOD) filter.department = user.department;
  else if (query.department) filter.department = query.department;
  return filter;
};

// Newest first. The student names are left out here (they can be hundreds); open one list to read them.
export const listReminders = asyncHandler(async (req, res) => {
  const filter = scope(req.user, req.query);
  if (req.query.feeType) filter.feeType = req.query.feeType;
  const items = await FeeReminder.find(filter)
    .select('-students')
    .populate('department', 'name code')
    .populate('semester', 'name number')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  sendSuccess(res, items);
});

export const getReminder = asyncHandler(async (req, res) => {
  const reminder = await FeeReminder.findById(req.params.id).populate('department', 'name code').populate('semester', 'name number').lean();
  if (!reminder) throw ApiError.notFound('Reminder list not found');
  if (req.user.role === ROLES.HOD) assertDepartmentAccess(req.user, reminder.department._id);
  sendSuccess(res, reminder);
});

// "Create the list now": the finance office or the HOD builds the unpaid list of one fee on demand (a fresh snapshot).
export const makeReminder = asyncHandler(async (req, res) => {
  const notice = await FeeNotice.findById(req.body.notice);
  if (!notice) throw ApiError.notFound('Fee notice not found');
  if (req.user.role === ROLES.HOD) assertDepartmentAccess(req.user, notice.department);
  if (notice.status !== FEE_NOTICE_STATUS.PUBLISHED) throw ApiError.badRequest('Only a published fee has a list of unpaid students');

  const reminder = await createReminder(notice, 'manual', req.user._id);
  logAudit(req, 'fee.reminder_create', 'FeeReminder', reminder._id, { notice: String(notice._id), unpaid: reminder.unpaidCount });
  sendSuccess(res, reminder, `List created: ${reminder.unpaidCount} student(s) have not paid`, 201);
});
