import SupportDuty from '../models/SupportDuty.js';
import SupportStaff from '../models/SupportStaff.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { assertPlacementAccess } from '../utils/placement.js';
import { ROLES } from '../config/constants.js';

const addDays = (k, n) => {
  const d = new Date(`${k}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const MAX_DAYS = 31;

const dutyOr404 = async (id, user) => {
  const duty = await SupportDuty.findById(id);
  if (!duty) throw ApiError.notFound('Duty not found');
  assertPlacementAccess(user, duty); // an HOD reaches only their own department's duties; office duties belong to the principal
  return duty;
};

// The principal sees every department and office (or one place); an HOD always only their own department.
export const listDuties = asyncHandler(async (req, res) => {
  const { department, office, staff, status, date, from, to } = req.query;
  const filter = {};
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  else if (department) filter.department = department;
  else if (office) filter.office = office;
  if (staff) filter.staff = staff;
  if (status) filter.status = status;
  if (date) filter.date = date;
  else if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const duties = await SupportDuty.find(filter)
    .populate('staff', 'name designation hasPhoto photoUpdatedAt')
    .populate('department', 'name code')
    .populate('assignedBy', 'name')
    .sort({ date: -1, createdAt: -1 })
    .limit(500)
    .lean();
  sendSuccess(res, duties.filter((d) => d.staff)); // a duty whose staff member was removed is never shown
});

export const createDuty = asyncHandler(async (req, res) => {
  const { staff: staffId, date, repeatUntil, title, details } = req.body;
  const staff = await SupportStaff.findById(staffId);
  if (!staff) throw ApiError.notFound('Staff member not found');
  assertPlacementAccess(req.user, staff);
  if (staff.status === 'inactive') throw ApiError.badRequest('This staff member is inactive');

  const last = repeatUntil || date;
  const days = [];
  for (let d = date; d <= last; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > MAX_DAYS) throw ApiError.badRequest(`A duty can repeat for at most ${MAX_DAYS} days at a time`);
  }
  // The same duty for the same person on the same day is not created twice.
  const existing = await SupportDuty.find({ staff: staff._id, title, date: { $in: days } }).distinct('date');
  const fresh = days.filter((d) => !existing.includes(d));
  if (!fresh.length) throw ApiError.conflict('This duty is already assigned for those days');

  const docs = await SupportDuty.insertMany(
    fresh.map((d) => ({ staff: staff._id, department: staff.department || null, office: staff.office || '', date: d, title, details: details || '', assignedBy: req.user._id }))
  );
  logAudit(req, 'support_duty.assign', 'SupportDuty', docs[0]._id, { staff: staff.name, title, days: docs.length });
  sendSuccess(res, { created: docs.length, skipped: days.length - docs.length }, docs.length === 1 ? 'Duty assigned' : `Duty assigned for ${docs.length} days`, 201);
});

export const updateDuty = asyncHandler(async (req, res) => {
  const duty = await dutyOr404(req.params.id, req.user);
  const wasDone = duty.status === 'done';
  duty.set(req.body);
  if (req.body.status) {
    duty.updatedBy = req.user._id;
    duty.completedAt = req.body.status === 'done' ? (wasDone ? duty.completedAt : new Date()) : null;
  }
  await duty.save();
  logAudit(req, 'support_duty.update', 'SupportDuty', duty._id, { fields: Object.keys(req.body) });
  sendSuccess(res, duty, 'Saved');
});

export const deleteDuty = asyncHandler(async (req, res) => {
  const duty = await dutyOr404(req.params.id, req.user);
  await duty.deleteOne();
  logAudit(req, 'support_duty.delete', 'SupportDuty', duty._id, { title: duty.title });
  sendSuccess(res, null, 'Duty removed');
});
