import ClassFourStaff from '../models/ClassFourStaff.js';
import ClassFourAttendance from '../models/ClassFourAttendance.js';
import ClassFourDuty from '../models/ClassFourDuty.js';
import Department from '../models/Department.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { ROLES } from '../config/constants.js';

const addDays = (k, n) => {
  const d = new Date(`${k}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const utcToday = () => new Date().toISOString().slice(0, 10);

// The HOD only ever sees his own department; the principal sees all, or one department when asked.
const scopeFilter = (req) => {
  if (req.user.role === ROLES.HOD) return { department: req.user.department };
  return req.query.department ? { department: req.query.department } : {};
};
const staffOr404 = async (id) => {
  const s = await ClassFourStaff.findById(id);
  if (!s) throw ApiError.notFound('Staff member not found');
  return s;
};

// ---------- the staff (the principal adds, edits and removes) ----------
export const listStaff = asyncHandler(async (req, res) => {
  const filter = scopeFilter(req);
  if (req.query.status) filter.status = req.query.status;
  const staff = await ClassFourStaff.find(filter).populate('department', 'name code').sort({ name: 1 }).lean();
  sendSuccess(res, staff);
});

export const createStaff = asyncHandler(async (req, res) => {
  if (!(await Department.exists({ _id: req.body.department }))) throw ApiError.badRequest('Department not found');
  const staff = await ClassFourStaff.create({ ...req.body, createdBy: req.user._id });
  logAudit(req, 'class_four.create', 'ClassFourStaff', staff._id, { name: staff.name });
  sendSuccess(res, staff, 'Staff member added', 201);
});

export const updateStaff = asyncHandler(async (req, res) => {
  const staff = await staffOr404(req.params.id);
  if (req.body.department && !(await Department.exists({ _id: req.body.department }))) throw ApiError.badRequest('Department not found');
  staff.set(req.body);
  await staff.save();
  logAudit(req, 'class_four.update', 'ClassFourStaff', staff._id, { fields: Object.keys(req.body) });
  sendSuccess(res, staff, 'Saved');
});

// Removing a person also removes their attendance and duty records. "Inactive" (edit) keeps the history instead.
export const deleteStaff = asyncHandler(async (req, res) => {
  const staff = await staffOr404(req.params.id);
  await Promise.all([ClassFourAttendance.deleteMany({ staff: staff._id }), ClassFourDuty.deleteMany({ staff: staff._id })]);
  await staff.deleteOne();
  logAudit(req, 'class_four.delete', 'ClassFourStaff', staff._id, { name: staff.name });
  sendSuccess(res, null, 'Staff member removed');
});

// ---------- attendance (the HOD of the department or the principal) ----------
export const attendanceSheet = asyncHandler(async (req, res) => {
  const date = req.query.date || utcToday();
  const staff = await ClassFourStaff.find({ ...scopeFilter(req), status: 'active' }).populate('department', 'name code').sort({ name: 1 }).lean();
  const rows = await ClassFourAttendance.find({ date, staff: { $in: staff.map((s) => s._id) } }).lean();
  const by = new Map(rows.map((r) => [String(r.staff), r]));
  sendSuccess(res, {
    date,
    rows: staff.map((s) => ({ staff: s, status: by.get(String(s._id))?.status || null, note: by.get(String(s._id))?.note || '' })),
  });
});

export const saveAttendance = asyncHandler(async (req, res) => {
  const { date, records } = req.body;
  if (date > addDays(utcToday(), 1)) throw ApiError.badRequest('Attendance cannot be marked for a future date');
  const ids = records.map((r) => String(r.staff));
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('A staff member appears twice');
  const staff = await ClassFourStaff.find({ _id: { $in: ids } });
  if (staff.length !== ids.length) throw ApiError.badRequest('A staff member was not found');
  for (const s of staff) assertDepartmentAccess(req.user, s.department);

  const byId = new Map(staff.map((s) => [String(s._id), s]));
  await ClassFourAttendance.bulkWrite(
    records.map((r) => ({
      updateOne: {
        filter: { staff: r.staff, date },
        update: { $set: { department: byId.get(String(r.staff)).department, status: r.status, note: r.note || '', markedBy: req.user._id } },
        upsert: true,
      },
    }))
  );
  logAudit(req, 'class_four.attendance', 'ClassFourAttendance', null, { date, count: records.length });
  sendSuccess(res, { count: records.length }, 'Attendance saved');
});

export const monthSummary = asyncHandler(async (req, res) => {
  const month = req.query.month || utcToday().slice(0, 7);
  const staff = await ClassFourStaff.find({ ...scopeFilter(req), status: 'active' }).populate('department', 'name code').sort({ name: 1 }).lean();
  const agg = await ClassFourAttendance.aggregate([
    { $match: { staff: { $in: staff.map((s) => s._id) }, date: { $gte: `${month}-01`, $lte: `${month}-31` } } },
    { $group: { _id: { staff: '$staff', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const a of agg) {
    const k = String(a._id.staff);
    map.set(k, { ...(map.get(k) || { present: 0, absent: 0, leave: 0 }), [a._id.status]: a.n });
  }
  sendSuccess(res, { month, rows: staff.map((s) => ({ staff: s, ...{ present: 0, absent: 0, leave: 0 }, ...(map.get(String(s._id)) || {}) })) });
});

// ---------- duties / other activity ----------
export const listDuties = asyncHandler(async (req, res) => {
  const filter = scopeFilter(req);
  if (req.query.date) filter.date = req.query.date;
  const duties = await ClassFourDuty.find(filter).populate('staff', 'name designation').populate('assignedBy', 'name').sort({ date: -1, createdAt: -1 }).limit(300).lean();
  sendSuccess(res, duties);
});

export const createDuty = asyncHandler(async (req, res) => {
  const staff = await staffOr404(req.body.staff);
  assertDepartmentAccess(req.user, staff.department);
  if (staff.status !== 'active') throw ApiError.badRequest('This staff member is inactive');
  const duty = await ClassFourDuty.create({ ...req.body, department: staff.department, assignedBy: req.user._id });
  logAudit(req, 'class_four.duty', 'ClassFourDuty', duty._id, { staff: staff.name, title: duty.title });
  sendSuccess(res, duty, 'Duty assigned', 201);
});

export const updateDuty = asyncHandler(async (req, res) => {
  const duty = await ClassFourDuty.findById(req.params.id);
  if (!duty) throw ApiError.notFound('Duty not found');
  assertDepartmentAccess(req.user, duty.department);
  duty.set(req.body);
  await duty.save();
  sendSuccess(res, duty, 'Saved');
});

export const deleteDuty = asyncHandler(async (req, res) => {
  const duty = await ClassFourDuty.findById(req.params.id);
  if (!duty) throw ApiError.notFound('Duty not found');
  assertDepartmentAccess(req.user, duty.department);
  await duty.deleteOne();
  sendSuccess(res, null, 'Duty removed');
});
