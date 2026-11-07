import Payment from '../models/Payment.js';
import StudentProfile from '../models/StudentProfile.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { PAYMENT_STATUS, STUDENT_STATUS } from '../config/constants.js';

// Active students who belong to a semester: those placed in it now PLUS those who were enrolled in it earlier
// (they have since moved to a higher semester but may still owe its fees, for example the promotion fee).
export const semesterProfiles = async (semesterId) => {
  const enrolled = await CourseEnrollment.find({ semester: semesterId }).distinct('student');
  return StudentProfile.find({ status: STUDENT_STATUS.ACTIVE, $or: [{ semester: semesterId }, { user: { $in: enrolled } }] }).lean();
};

const DAY = 24 * 60 * 60 * 1000;

// A deadline of "10 November" means "until the end of 10 November" (UTC day).
export const endOfDay = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) + DAY - 1);
};
const startOfDay = (d) => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

// ===== Fee rule (pure, unit tested) =====
//   fee      = exam fee + practicals x practical fee            (practicals = how many practicals the student has)
//   late fee = lateFee  + practicals x practical late fee        (only when paying after the normal deadline)
//   before startDate                      -> not_started (cannot be paid yet)
//   up to the end of dueDate              -> normal: fee
//   after dueDate, up to end of lateDueDate -> late: fee + late fee
//   after that                            -> closed (cannot be paid online)
// The price is always calculated on the SERVER at the moment of checkout, never trusted from the browser.
// It is ONE amount: the exam fee and the practical fees are never paid separately.
export const clampPracticals = (notice, wanted) => {
  if (!(notice.practicalFee > 0)) return 0; // this notice has no practical fee
  const max = notice.maxPracticals ?? 3;
  return Math.max(0, Math.min(Math.floor(Number(wanted) || 0), max));
};

export const priceNotice = (notice, now = new Date(), lateFeeEnabled = true, practicals = 0) => {
  const count = clampPracticals(notice, practicals);
  const examAmount = notice.amount;
  const practicalAmount = count * (notice.practicalFee || 0);
  const baseAmount = examAmount + practicalAmount;
  const out = (phase, lateFee = 0, practicalLateFee = 0) => ({
    phase, examAmount, practicals: count, practicalAmount, practicalLateFee, baseAmount, lateFee, total: baseAmount + lateFee,
  });
  if (now < startOfDay(notice.startDate)) return out('not_started');
  if (now <= endOfDay(notice.dueDate)) return out('normal');
  if (lateFeeEnabled && notice.lateDueDate && now <= endOfDay(notice.lateDueDate)) {
    const practicalLate = count * (notice.practicalLateFee || 0);
    return out('late', (notice.lateFee || 0) + practicalLate, practicalLate);
  }
  return out('closed');
};

export const isPayablePhase = (phase) => phase === 'normal' || phase === 'late';

// Ids of fee notices this student has actually paid (verified, not refunded).
export const paidNoticeIds = async (studentId) => {
  const payments = await Payment.find({ student: studentId, status: PAYMENT_STATUS.PAID }).select('items.notice').lean();
  return new Set(payments.flatMap((p) => p.items.map((i) => String(i.notice))));
};

// Ids of fee notices that are inside a bank transfer still waiting for the finance office to check it.
export const pendingBankNoticeIds = async (studentId) => {
  const payments = await Payment.find({ student: studentId, method: 'bank', status: PAYMENT_STATUS.PENDING }).select('items.notice').lean();
  return new Set(payments.flatMap((p) => p.items.map((i) => String(i.notice))));
};
