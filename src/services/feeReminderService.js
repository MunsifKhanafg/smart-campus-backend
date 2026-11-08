import FeeNotice from '../models/FeeNotice.js';
import FeeReminder from '../models/FeeReminder.js';
import Payment from '../models/Payment.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import { notifyUsers } from '../utils/notify.js';
import { semesterProfiles, endOfDay } from './feeService.js';
import { FEE_NOTICE_STATUS, PAYMENT_STATUS, ROLES } from '../config/constants.js';

// ============================================================================================================
// Automatic "who has not paid yet" lists for the HODs.
//
// For every PUBLISHED examination / promotion fee the server watches two deadlines: the normal payment deadline and the
// late payment deadline. For each of them it sends ONE reminder when the deadline is near (default 3 days before) and ONE on the
// day of the deadline. A reminder is a saved list (FeeReminder) of the students of that department and semester who have not
// paid yet, and a notification to the HOD of the department and to the finance officers.
//
// A student whose bank / wallet transfer is still waiting for the finance office is marked "bankPending" in the list, so the HOD
// does not chase someone who has already paid.
// ============================================================================================================

const DAY = 24 * 60 * 60 * 1000;
export const REMINDER_FEE_TYPES = ['examination', 'practical', 'promotion'];
export const reminderDays = () => Math.max(1, Number(process.env.FEE_REMINDER_DAYS) || 3);

const TRIGGER_TEXT = {
  due_near: 'The payment deadline is close',
  due_day: 'Today is the last day to pay without a late fee',
  late_near: 'The late payment deadline is close',
  late_day: 'Today is the last day to pay with the late fee',
  manual: 'Reminder list',
};

// Which reminders are due for this notice right now. Pure, so it can be unit tested.
//   <days> before a deadline  -> "near"      on the deadline day -> "day"      after the deadline -> nothing
export const dueTriggers = (notice, now = new Date(), days = reminderDays()) => {
  const out = [];
  const check = (deadline, near, onDay) => {
    if (!deadline) return;
    const end = endOfDay(deadline).getTime();
    const start = end - DAY + 1; // first moment of the deadline day
    const t = now.getTime();
    if (t >= start && t <= end) out.push(onDay);
    else if (t < start && start - t <= days * DAY) out.push(near);
  };
  check(notice.dueDate, 'due_near', 'due_day');
  check(notice.lateDueDate, 'late_near', 'late_day');
  return out;
};

// The students of the notice's department and semester who have not paid it.
export const unpaidStudents = async (notice) => {
  const profiles = (await semesterProfiles(notice.semester)).filter((p) => String(p.department) === String(notice.department));
  const ids = profiles.map((p) => p.user);
  const [paid, waiting, users] = await Promise.all([
    Payment.find({ student: { $in: ids }, status: PAYMENT_STATUS.PAID, 'items.notice': notice._id }).distinct('student'),
    Payment.find({ student: { $in: ids }, method: 'bank', status: PAYMENT_STATUS.PENDING, 'items.notice': notice._id }).distinct('student'),
    User.find({ _id: { $in: ids } }).select('name email').lean(),
  ]);
  const paidSet = new Set(paid.map(String));
  const waitingSet = new Set(waiting.map(String));
  const info = new Map(users.map((u) => [String(u._id), u]));
  const students = profiles
    .filter((p) => !paidSet.has(String(p.user)))
    .map((p) => ({
      student: p.user,
      name: info.get(String(p.user))?.name || '',
      rollNumber: p.rollNumber,
      email: info.get(String(p.user))?.email || '',
      bankPending: waitingSet.has(String(p.user)),
    }))
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));
  return { students, total: profiles.length };
};

const fmt = (d) => new Date(d).toISOString().slice(0, 10);

// Saves the list and notifies the department's HOD and the finance officers. Returns the saved reminder.
export const createReminder = async (notice, trigger, createdBy = null) => {
  const { students, total } = await unpaidStudents(notice);
  if (!students.length && trigger !== 'manual') return null; // everybody paid: nothing to chase

  const late = trigger.startsWith('late');
  const deadline = late ? notice.lateDueDate : notice.dueDate;
  const title = notice.batchTitle || notice.title;
  const reminder = await FeeReminder.create({
    notice: notice._id,
    department: notice.department,
    semester: notice.semester,
    feeType: notice.feeType,
    title,
    trigger,
    deadline,
    totalStudents: total,
    unpaidCount: students.length,
    students,
    createdBy,
  });

  const dept = await Department.findById(notice.department).select('hod name').lean();
  const officers = await User.find({ role: ROLES.FINANCE_OFFICER, isActive: true }).distinct('_id');
  const waiting = students.filter((s) => s.bankPending).length;
  const message =
    `${TRIGGER_TEXT[trigger]} (${fmt(deadline)}). ${students.length} of ${total} students of ${dept?.name || 'your department'} have not paid "${title}" yet` +
    `${waiting ? ` (${waiting} of them sent a transfer that is waiting for the finance office)` : ''}. Open the list.`;
  const body = { title: `Unpaid ${notice.feeType === 'promotion' ? 'promotion' : 'examination'} fee: ${students.length} students`, message, type: 'fee', link: '/fee-reminders' };
  if (dept?.hod) await notifyUsers([dept.hod], body);
  await notifyUsers(officers, body);
  return reminder;
};

// Runs from the server timer (every 30 minutes). Safe to run as often as you like: each reminder is claimed with one atomic
// update on the notice (remindersSent), so a second run, or a second server, can never send the same reminder twice.
export const runFeeReminders = async (now = new Date()) => {
  const notices = await FeeNotice.find({
    status: FEE_NOTICE_STATUS.PUBLISHED,
    feeType: { $in: REMINDER_FEE_TYPES },
    $or: [{ dueDate: { $gte: new Date(now.getTime() - DAY) } }, { lateDueDate: { $gte: new Date(now.getTime() - DAY) } }],
  });
  let sent = 0;
  for (const notice of notices) {
    for (const trigger of dueTriggers(notice, now)) {
      if ((notice.remindersSent || []).includes(trigger)) continue;
      const claimed = await FeeNotice.updateOne({ _id: notice._id, remindersSent: { $ne: trigger } }, { $addToSet: { remindersSent: trigger } });
      if (claimed.modifiedCount !== 1) continue; // another run already took it
      if (await createReminder(notice, trigger)) sent += 1;
    }
  }
  return sent;
};
