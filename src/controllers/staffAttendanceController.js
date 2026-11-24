import User from '../models/User.js';
import StaffAttendance from '../models/StaffAttendance.js';
import StaffAttendanceRules from '../models/StaffAttendanceRules.js';
import StaffLeave from '../models/StaffLeave.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { ROLES } from '../config/constants.js';
import { localNow, addDays, checkInDecision, checkProof, middayDecision, toMinutes } from '../services/staffAttendanceRules.js';
import {
  STAFF_ROLES, loadClosedEvents, workingDay, ensureAbsentees, moveTopicsToNextDay, applyApprovedLeave, applyRestOfDayLeave, reviewerIdsFor, staffScope, canReviewPerson,
} from '../services/staffAttendanceService.js';

const rulesView = (r) => ({
  timezone: r.timezone, opensAt: r.opensAt, graceMinutes: r.graceMinutes, absentAfter: r.absentAfter, closesAt: r.closesAt,
  campus: { lat: r.campus?.lat ?? null, lng: r.campus?.lng ?? null, radiusMeters: r.campus?.radiusMeters ?? 300 },
  requireOnCampus: r.requireOnCampus, maxAccuracyMeters: r.maxAccuracyMeters,
  middayRequired: r.middayRequired, middayOpensAt: r.middayOpensAt, middayFrom: r.middayFrom || '',
});

const requireStaff = (user) => {
  if (!STAFF_ROLES.includes(user.role)) throw ApiError.forbidden('Only teachers, HODs and the finance officer mark their own attendance');
};
const today = async () => {
  const rules = await StaffAttendanceRules.getRules();
  return { rules, now: localNow(new Date(), rules.timezone) };
};

// ---------- the college's rules ----------
export const getRules = asyncHandler(async (_req, res) => sendSuccess(res, rulesView(await StaffAttendanceRules.getRules())));

export const updateRules = asyncHandler(async (req, res) => {
  const rules = await StaffAttendanceRules.getRules();
  const { campus, ...rest } = req.body;
  rules.set(rest);
  if (campus) for (const [k, v] of Object.entries(campus)) rules.set(`campus.${k}`, v);
  if (toMinutes(rules.absentAfter) <= toMinutes(rules.opensAt)) throw ApiError.badRequest('The absent time must be after the time the college starts');
  if (toMinutes(rules.opensAt) + rules.graceMinutes >= toMinutes(rules.absentAfter)) throw ApiError.badRequest('The late time (start + grace) must come before the absent time');
  if (rules.middayRequired) {
    if (toMinutes(rules.middayOpensAt) <= toMinutes(rules.absentAfter)) throw ApiError.badRequest('The break-time attendance must open after the morning absent time');
    if (toMinutes(rules.closesAt) <= toMinutes(rules.middayOpensAt)) throw ApiError.badRequest('The break-time attendance must close after it opens');
  }
  if (rules.requireOnCampus && (rules.campus.lat == null || rules.campus.lng == null)) {
    // Allowed: the proof is simply not checked until the campus point is set. The page tells the principal.
  }
  rules.updatedBy = req.user._id;
  await rules.save();
  logAudit(req, 'staff_attendance.rules', 'StaffAttendanceRules', rules._id, { fields: Object.keys(req.body) });
  sendSuccess(res, rulesView(rules), 'Attendance rules saved');
});

// ---------- my day ----------
export const myToday = asyncHandler(async (req, res) => {
  requireStaff(req.user);
  await ensureAbsentees();
  const { rules, now } = await today();
  const settings = await UniversitySettings.getSettings();
  const events = await loadClosedEvents(now.dateKey, now.dateKey);
  const day = workingDay(now.dateKey, req.user.department, settings, events);
  const record = await StaffAttendance.findOne({ user: req.user._id, date: now.dateKey }).lean();
  const decision = checkInDecision({ nowMin: now.minutes, opensAt: rules.opensAt, graceMinutes: rules.graceMinutes, absentAfter: rules.absentAfter });
  let state = record ? 'done' : !day.working ? 'holiday' : decision.state; // done | holiday | not_open | on_time | late | closed
  if (record && record.status === 'absent') state = 'absent';

  // The break-time attendance (the second one, about 1 pm) and the leave for the rest of the day.
  const here = !!record && ['present', 'late'].includes(record.status);
  const middayOn = !!rules.middayRequired && !!rules.middayFrom && now.dateKey >= rules.middayFrom;
  const breakWindow = middayDecision({ nowMin: now.minutes, middayOpensAt: rules.middayOpensAt, closesAt: rules.closesAt });
  const midday = { required: middayOn, state: 'off', opensAt: rules.middayOpensAt, closesAt: rules.closesAt, at: record?.midday?.at || null, onCampus: record?.midday?.proof?.onCampus ?? null };
  if (middayOn && here) {
    midday.state = record.midday?.at ? 'done' : record.afternoon === 'leave' ? 'leave' : record.afternoon === 'missed' || breakWindow.state === 'closed' ? 'missed' : breakWindow.state; // done | leave | missed | not_open | open
  }
  const restLeave = here
    ? await StaffLeave.findOne({ user: req.user._id, kind: 'rest_of_day', fromDate: now.dateKey, status: { $in: ['pending', 'approved', 'rejected'] } }).sort({ createdAt: -1 }).lean()
    : null;
  const canLeaveEarly = here && !record.checkOutAt && (!restLeave || restLeave.status === 'rejected');
  sendSuccess(res, { date: now.dateKey, nowMinutes: now.minutes, state, holidayReason: day.reason, decision, record, rules: rulesView(rules), midday, restLeave, canLeaveEarly });
});

export const checkIn = asyncHandler(async (req, res) => {
  requireStaff(req.user);
  await ensureAbsentees();
  const { rules, now } = await today();
  const settings = await UniversitySettings.getSettings();
  const events = await loadClosedEvents(now.dateKey, now.dateKey);
  const day = workingDay(now.dateKey, req.user.department, settings, events);
  if (!day.working) throw ApiError.badRequest(`Today is not a working day (${day.reason}). There is nothing to check in to`);

  const existing = await StaffAttendance.findOne({ user: req.user._id, date: now.dateKey });
  if (existing) {
    if (existing.status === 'absent') throw ApiError.conflict(`You were marked absent today because there was no check-in before ${rules.absentAfter}. Ask your HOD or the principal to correct it`);
    if (existing.status === 'leave') throw ApiError.conflict('You are on approved leave today');
    throw ApiError.conflict(`You already checked in today at ${existing.checkInAt.toLocaleTimeString('en-GB', { timeZone: rules.timezone, hour: '2-digit', minute: '2-digit' })}`);
  }

  const decision = checkInDecision({ nowMin: now.minutes, opensAt: rules.opensAt, graceMinutes: rules.graceMinutes, absentAfter: rules.absentAfter });
  if (decision.state === 'not_open') throw ApiError.badRequest(`Check-in opens when the college starts at ${rules.opensAt}. Please try again in ${decision.opensInMinutes} minute(s)`);
  if (decision.state === 'closed') throw ApiError.forbidden(`Check-in closed at ${rules.absentAfter}. You are marked absent today. Ask your HOD or the principal to correct it`);

  const { lat, lng, accuracy } = req.body;
  const proof = checkProof({ campus: rules.campus, lat, lng, accuracy, maxAccuracyMeters: rules.maxAccuracyMeters });
  if (rules.requireOnCampus && proof.configured && !proof.ok) throw ApiError.forbidden(proof.reason);

  try {
    const record = await StaffAttendance.create({
      user: req.user._id, department: req.user.department || null, date: now.dateKey,
      status: decision.status, minutesLate: decision.minutesLate, checkInAt: new Date(),
      proof: {
        method: lat != null && lng != null ? 'gps' : 'none', lat, lng, accuracy,
        distanceMeters: proof.distance, onCampus: proof.onCampus, ip: req.ip || '',
      },
      note: req.body.note || '',
    });
    sendSuccess(res, record, decision.status === 'late' ? `Checked in, but you are ${decision.minutesLate} minute(s) late` : 'Checked in. Have a good day', 201);
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('You already checked in today');
    throw err;
  }
});

// The SECOND attendance of the day, at the break (about 1 pm). It is made from inside the college with the same location proof as the morning
// check-in, so checking in at 8:30 and then going home does not work: from outside the college it is refused and the day shows "missed".
export const middayCheckIn = asyncHandler(async (req, res) => {
  requireStaff(req.user);
  await ensureAbsentees();
  const { rules, now } = await today();
  if (!rules.middayRequired || !rules.middayFrom || now.dateKey < rules.middayFrom) throw ApiError.badRequest('The college does not ask for the break-time attendance today');
  const record = await StaffAttendance.findOne({ user: req.user._id, date: now.dateKey });
  if (!record || !['present', 'late'].includes(record.status)) throw ApiError.badRequest('Check in first. The break-time attendance is for staff who checked in this morning');
  if (record.midday?.at) throw ApiError.conflict(`You already marked the break-time attendance at ${record.midday.at.toLocaleTimeString('en-GB', { timeZone: rules.timezone, hour: '2-digit', minute: '2-digit' })}`);
  if (record.afternoon === 'leave') throw ApiError.conflict('Your leave for the rest of the day was approved, so the break-time attendance is not needed');

  const decision = middayDecision({ nowMin: now.minutes, middayOpensAt: rules.middayOpensAt, closesAt: rules.closesAt });
  if (decision.state === 'not_open') throw ApiError.badRequest(`The break-time attendance opens at ${rules.middayOpensAt}. Please try again in ${decision.opensInMinutes} minute(s)`);
  if (decision.state === 'closed' || record.afternoon === 'missed') throw ApiError.forbidden(`The break-time attendance closed at ${rules.closesAt}, so it is recorded as missed. Ask your HOD or the principal to correct it`);

  const { lat, lng, accuracy } = req.body;
  const proof = checkProof({ campus: rules.campus, lat, lng, accuracy, maxAccuracyMeters: rules.maxAccuracyMeters });
  if (rules.requireOnCampus && proof.configured && !proof.ok) throw ApiError.forbidden(proof.reason);

  record.midday = { at: new Date(), proof: { lat, lng, accuracy, distanceMeters: proof.distance, onCampus: proof.onCampus, ip: req.ip || '' } };
  record.afternoon = 'present';
  await record.save();
  sendSuccess(res, record, 'Break-time attendance marked. Thank you');
});

export const checkOut = asyncHandler(async (req, res) => {
  requireStaff(req.user);
  const { now } = await today();
  const record = await StaffAttendance.findOne({ user: req.user._id, date: now.dateKey });
  if (!record || !record.checkInAt) throw ApiError.badRequest('You have not checked in today');
  if (record.checkOutAt) throw ApiError.conflict('You already checked out today');
  // Leaving before the break-time attendance is done (and without approved leave) is exactly what that attendance exists to stop.
  const rl = await StaffAttendanceRules.getRules();
  const pendingBreak = rl.middayRequired && rl.middayFrom && record.date >= rl.middayFrom && ['present', 'late'].includes(record.status)
    && !record.midday?.at && !['leave', 'missed'].includes(record.afternoon) && now.minutes < toMinutes(rl.closesAt);
  if (pendingBreak) {
    throw ApiError.forbidden(`You cannot check out before the break-time attendance (${rl.middayOpensAt} to ${rl.closesAt}). To leave early, press "Leave early" and wait until your HOD approves it`);
  }
  record.checkOutAt = new Date();
  await record.save();
  sendSuccess(res, record, 'Checked out');
});

// ---------- my month ----------
export const myMonth = asyncHandler(async (req, res) => {
  requireStaff(req.user);
  await ensureAbsentees();
  const { now } = await today();
  const month = req.query.month || now.dateKey.slice(0, 7);
  const from = `${month}-01`;
  const to = `${month}-31`;
  const records = await StaffAttendance.find({ user: req.user._id, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean();
  const counts = records.reduce((n, r) => ({ ...n, [r.status]: (n[r.status] || 0) + 1 }), { present: 0, late: 0, absent: 0, leave: 0 });
  sendSuccess(res, { month, records, counts });
});

// ---------- the reviewer's view ----------
export const overview = asyncHandler(async (req, res) => {
  const scope = staffScope(req.user);
  if (!scope) throw ApiError.forbidden();
  await ensureAbsentees();
  const { now } = await today();
  const date = req.query.date || now.dateKey;
  const filter = { ...scope, isActive: true };
  if (req.user.role === ROLES.UNIVERSITY_HEAD && req.query.department) filter.department = req.query.department;

  const people = await User.find(filter).select('name role department hasPhoto photoUpdatedAt').populate('department', 'name code').sort({ name: 1 }).lean();
  const records = await StaffAttendance.find({ date, user: { $in: people.map((p) => p._id) } }).lean();
  const byUser = new Map(records.map((r) => [String(r.user), r]));
  const rows = people.map((p) => {
    const r = byUser.get(String(p._id));
    return {
      user: p, status: r?.status || 'not_marked', checkInAt: r?.checkInAt || null, checkOutAt: r?.checkOutAt || null, minutesLate: r?.minutesLate || 0,
      auto: !!r?.auto, onCampus: r?.proof?.onCampus ?? null, distanceMeters: r?.proof?.distanceMeters ?? null, note: r?.note || '', topicsMoved: r?.topicsMoved || 0,
      afternoon: r?.afternoon || '', middayAt: r?.midday?.at || null, middayOnCampus: r?.midday?.proof?.onCampus ?? null,
    };
  });
  const counts = rows.reduce((n, r) => ({ ...n, [r.status]: (n[r.status] || 0) + 1 }), {});
  const pendingLeaves = await StaffLeave.countDocuments({ status: 'pending', user: { $in: people.map((p) => p._id) } });
  sendSuccess(res, { date, rows, counts, pendingLeaves });
});

export const monthlySummary = asyncHandler(async (req, res) => {
  const scope = staffScope(req.user);
  if (!scope) throw ApiError.forbidden();
  await ensureAbsentees();
  const { now } = await today();
  const month = req.query.month || now.dateKey.slice(0, 7);
  const people = await User.find({ ...scope, isActive: true }).select('name role department').populate('department', 'name code').sort({ name: 1 }).lean();
  const agg = await StaffAttendance.aggregate([
    { $match: { user: { $in: people.map((p) => p._id) }, date: { $gte: `${month}-01`, $lte: `${month}-31` } } },
    { $group: { _id: { user: '$user', status: '$status' }, n: { $sum: 1 }, minutes: { $sum: '$minutesLate' } } },
  ]);
  const map = new Map();
  for (const a of agg) {
    const k = String(a._id.user);
    const row = map.get(k) || { present: 0, late: 0, absent: 0, leave: 0, minutesLate: 0 };
    row[a._id.status] = a.n;
    if (a._id.status === 'late') row.minutesLate = a.minutes;
    map.set(k, row);
  }
  const missedAgg = await StaffAttendance.aggregate([
    { $match: { user: { $in: people.map((p) => p._id) }, date: { $gte: `${month}-01`, $lte: `${month}-31` }, afternoon: 'missed' } },
    { $group: { _id: '$user', n: { $sum: 1 } } },
  ]);
  const missed = new Map(missedAgg.map((a) => [String(a._id), a.n]));
  sendSuccess(res, { month, rows: people.map((p) => ({ user: p, ...(map.get(String(p._id)) || { present: 0, late: 0, absent: 0, leave: 0, minutesLate: 0 }), missedBreak: missed.get(String(p._id)) || 0 })) });
});

// The principal / HOD corrects a day (a teacher who really came, or an absence the system could not know about).
export const markStaff = asyncHandler(async (req, res) => {
  const { user: userId, date, status, note, afternoon } = req.body;
  const person = await User.findById(userId).select('name role department');
  if (!person || !STAFF_ROLES.includes(person.role)) throw ApiError.notFound('Teacher not found');
  if (!canReviewPerson(req.user, person)) throw ApiError.forbidden('You can only correct the attendance of the teachers you are responsible for');
  const { now } = await today();
  if (date > now.dateKey) throw ApiError.badRequest('You cannot mark a day that has not come yet');

  const record = await StaffAttendance.findOneAndUpdate(
    { user: person._id, date },
    { $set: { department: person.department || null, status, auto: false, markedBy: req.user._id, note, minutesLate: status === 'late' ? 1 : 0, ...(afternoon ? { afternoon } : {}) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  let moved = { moved: 0, stuck: 0 };
  if (status === 'absent' || status === 'leave') {
    moved = await moveTopicsToNextDay(person._id, date);
    await StaffAttendance.updateOne({ _id: record._id }, { topicsMoved: moved.moved });
  }
  logAudit(req, 'staff_attendance.mark', 'StaffAttendance', record._id, { person: person.name, date, status });
  await notifyUsers([person._id], { title: 'Your attendance was corrected', message: `${req.user.name} marked you "${status}" on ${date}. Note: ${note}`, type: 'attendance', link: '/staff-attendance' });
  sendSuccess(res, { record, ...moved }, `Saved. ${moved.moved ? `${moved.moved} course content(s) moved to the next teaching day.` : ''}`.trim());
});

// A teacher (or the HOD / principal for them) moves the contents of a day to the next teaching day by hand.
export const moveTopics = asyncHandler(async (req, res) => {
  const targetId = req.body.user || req.user._id;
  if (String(targetId) !== String(req.user._id)) {
    const person = await User.findById(targetId).select('role department');
    if (!person || !canReviewPerson(req.user, person)) throw ApiError.forbidden();
  } else requireStaff(req.user);
  const result = await moveTopicsToNextDay(targetId, req.body.date);
  logAudit(req, 'staff_attendance.move_topics', 'User', targetId, { date: req.body.date, moved: result.moved });
  sendSuccess(res, result, result.moved ? `${result.moved} course content(s) moved to the next teaching day` : 'Nothing was planned on that day');
});

// ---------- leave requests ----------
// "I already checked in and I need to leave the college for the rest of the day." This is only possible AFTER checking in today.
// Until the HOD (or the principal) approves it the teacher has to stay: without the approval the break-time attendance is still due,
// and checking out is refused.
const requestRestOfDayLeave = async (req, res) => {
  const { reason, type, leaveTime } = req.body;
  const { now } = await today();
  const record = await StaffAttendance.findOne({ user: req.user._id, date: now.dateKey });
  if (!record || !['present', 'late'].includes(record.status)) throw ApiError.badRequest('Mark your attendance first. Leave for the rest of the day can only be asked for after you checked in today');
  if (record.checkOutAt) throw ApiError.badRequest('You already checked out today');
  if (!leaveTime) throw ApiError.badRequest('Choose the time you need to leave');
  if (toMinutes(leaveTime) < now.minutes) throw ApiError.badRequest('The time you leave cannot be in the past');
  const open = await StaffLeave.findOne({ user: req.user._id, status: { $in: ['pending', 'approved'] }, fromDate: { $lte: now.dateKey }, toDate: { $gte: now.dateKey } });
  if (open) throw ApiError.conflict(open.kind === 'rest_of_day' ? `You already have a ${open.status} request to leave at ${open.leaveTime} today` : `You already have a ${open.status} leave from ${open.fromDate} to ${open.toDate}`);

  const leave = await StaffLeave.create({
    user: req.user._id, department: req.user.department || null, fromDate: now.dateKey, toDate: now.dateKey,
    kind: 'rest_of_day', leaveTime, type: type || 'casual', reason,
  });
  const reviewers = await reviewerIdsFor(req.user);
  await notifyUsers(reviewers, {
    title: 'Leave for the rest of the day',
    message: `${req.user.name} has checked in and asks to leave the college at ${leaveTime} for the rest of the day: ${reason}. Please decide now: the teacher waits for your answer.`,
    type: 'attendance', link: '/staff-attendance',
  });
  logAudit(req, 'staff_leave.request', 'StaffLeave', leave._id, { kind: 'rest_of_day', leaveTime });
  sendSuccess(res, leave, 'Request sent. Please stay at the college until it is approved', 201);
};

export const requestLeave = asyncHandler(async (req, res) => {
  requireStaff(req.user);
  if (req.body.kind === 'rest_of_day') return requestRestOfDayLeave(req, res);
  const { fromDate, toDate, type, reason } = req.body;
  const { now } = await today();
  if (fromDate < addDays(now.dateKey, -7)) throw ApiError.badRequest('A leave can start at most 7 days in the past');
  if (toDate > addDays(fromDate, 120)) throw ApiError.badRequest('A leave request can cover at most 120 days');
  const overlap = await StaffLeave.findOne({ user: req.user._id, status: { $in: ['pending', 'approved'] }, fromDate: { $lte: toDate }, toDate: { $gte: fromDate } });
  if (overlap) throw ApiError.conflict(`You already have a ${overlap.status} leave from ${overlap.fromDate} to ${overlap.toDate}`);

  const leave = await StaffLeave.create({ user: req.user._id, department: req.user.department || null, fromDate, toDate, type, reason });
  // A teacher's request goes to the HOD of the department and the principal. The request of an HOD or of the finance officer
  // (who belongs to no department) goes to the principal.
  const reviewers = await User.find({
    isActive: true,
    $or: req.user.role === ROLES.TEACHER ? [{ role: ROLES.UNIVERSITY_HEAD }, { role: ROLES.HOD, department: req.user.department }] : [{ role: ROLES.UNIVERSITY_HEAD }],
  }).distinct('_id');
  await notifyUsers(reviewers, { title: 'Leave request', message: `${req.user.name} asks for leave from ${fromDate} to ${toDate}: ${reason}`, type: 'attendance', link: '/staff-attendance' });
  logAudit(req, 'staff_leave.request', 'StaffLeave', leave._id, { fromDate, toDate });
  sendSuccess(res, leave, 'Leave requested. You will be told when it is decided', 201);
});

export const listLeaves = asyncHandler(async (req, res) => {
  const mine = req.query.scope !== 'review';
  let filter;
  if (mine) {
    requireStaff(req.user);
    filter = { user: req.user._id };
  } else {
    const scope = staffScope(req.user);
    if (!scope) throw ApiError.forbidden();
    const ids = await User.find({ ...scope, _id: { $ne: req.user._id } }).distinct('_id');
    filter = { user: { $in: ids } };
  }
  if (req.query.status) filter.status = req.query.status;
  const leaves = await StaffLeave.find(filter).populate('user', 'name role department').populate('reviewedBy', 'name').sort({ createdAt: -1 }).limit(100).lean();
  sendSuccess(res, leaves);
});

export const reviewLeave = asyncHandler(async (req, res) => {
  const leave = await StaffLeave.findById(req.params.id).populate('user', 'name role department');
  if (!leave) throw ApiError.notFound('Leave request not found');
  if (leave.status !== 'pending') throw ApiError.conflict(`This request was already ${leave.status}`);
  if (!canReviewPerson(req.user, leave.user)) throw ApiError.forbidden('You cannot decide this request');

  leave.status = req.body.status;
  leave.reviewNote = req.body.note || '';
  leave.reviewedBy = req.user._id;
  leave.reviewedAt = new Date();
  await leave.save();

  let applied = { marked: 0, topicsMoved: 0 };
  if (leave.status === 'approved') {
    applied = leave.kind === 'rest_of_day'
      ? await applyRestOfDayLeave({ _id: leave._id, user: leave.user._id, fromDate: leave.fromDate, leaveTime: leave.leaveTime })
      : await applyApprovedLeave({ _id: leave._id, user: leave.user._id, department: leave.department, fromDate: leave.fromDate, toDate: leave.toDate });
  }
  await notifyUsers([leave.user._id], {
    title: `Leave ${leave.status}`,
    message: (leave.kind === 'rest_of_day'
      ? (leave.status === 'approved' ? `${req.user.name} approved your request: you may leave the college at ${leave.leaveTime}.` : `${req.user.name} did not approve your request to leave at ${leave.leaveTime}. Please stay at the college.`)
      : `Your leave from ${leave.fromDate} to ${leave.toDate} was ${leave.status} by ${req.user.name}.`) + (leave.reviewNote ? ` Note: ${leave.reviewNote}` : ''),
    type: 'attendance', link: '/staff-attendance',
  });
  logAudit(req, `staff_leave.${leave.status}`, 'StaffLeave', leave._id, { person: leave.user.name });
  sendSuccess(res, { leave, ...applied }, leave.status === 'approved' ? `Approved. ${applied.topicsMoved} course content(s) moved to the next teaching day.` : 'Rejected');
});

export const cancelLeave = asyncHandler(async (req, res) => {
  requireStaff(req.user);
  const leave = await StaffLeave.findOne({ _id: req.params.id, user: req.user._id });
  if (!leave) throw ApiError.notFound('Leave request not found');
  const { now } = await today();
  if (leave.status === 'pending' || (leave.status === 'approved' && leave.fromDate > now.dateKey)) {
    if (leave.status === 'approved') await StaffAttendance.deleteMany({ leave: leave._id, date: { $gt: now.dateKey } });
    leave.status = 'cancelled';
    await leave.save();
    return sendSuccess(res, leave, 'Leave cancelled');
  }
  throw ApiError.badRequest('Only a waiting request, or an approved leave that has not started, can be cancelled');
});
