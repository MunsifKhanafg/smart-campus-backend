import Payment from '../models/Payment.js';
import FeeCart from '../models/FeeCart.js';
import FeeReceipt from '../models/FeeReceipt.js';
import FeeNotice from '../models/FeeNotice.js';
import StudentProfile from '../models/StudentProfile.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import Counter from '../models/Counter.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError } from '../utils/apiHelpers.js';
import { notifyUsers } from '../utils/notify.js';
import { smsToUser } from './smsService.js';
import { priceNotice, isPayablePhase, paidNoticeIds, pendingBankNoticeIds, clampPracticals } from './feeService.js';
import { FEE_NOTICE_STATUS, PAYMENT_STATUS } from '../config/constants.js';

// "Mid-Term Fee" + 2 practicals -> "Mid-Term Fee (fee + 2 practicals)"
export const lineTitle = (title, practicals) => (practicals > 0 ? `${title} (fee + ${practicals} practical${practicals === 1 ? '' : 's'})` : title);

// Builds the (unsaved) payment lines. `lines` is [{ notice, practicals }] (practicals = how many practical subjects the
// student has for that fee). Every rule is enforced here, on the server: the notice must be published, belong to the
// student's department, still be payable, and not already be paid. The exam fee and the practical fees become ONE line.
export const buildPaymentItems = async ({ studentId, profile, lines, noticeIds }) => {
  const want = lines || (noticeIds || []).map((id) => ({ notice: id, practicals: 0 }));
  const ids = want.map((l) => String(l.notice));
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('The same fee was selected twice');

  const settings = await UniversitySettings.getSettings();
  const notices = await FeeNotice.find({ _id: { $in: ids } });
  if (notices.length !== ids.length) throw ApiError.badRequest('A selected fee does not exist');

  const wanted = new Map(want.map((l) => [String(l.notice), Number(l.practicals) || 0]));
  const [already, pendingBank] = await Promise.all([paidNoticeIds(studentId), pendingBankNoticeIds(studentId)]);

  const items = notices.map((n) => {
    if (n.status !== FEE_NOTICE_STATUS.PUBLISHED) throw ApiError.badRequest(`"${n.title}" is not open for payment`);
    if (String(n.department) !== String(profile.department)) throw ApiError.forbidden('This fee belongs to another department');
    if (already.has(String(n._id))) throw ApiError.conflict(`"${n.title}" is already paid`);
    if (pendingBank.has(String(n._id))) throw ApiError.conflict(`"${n.title}" is already inside a bank transfer waiting for the finance office`);

    const asked = wanted.get(String(n._id));
    if (asked > 0 && !(n.practicalFee > 0)) throw ApiError.badRequest(`"${n.title}" has no practical fee`);
    if (asked > (n.maxPracticals ?? 3)) throw ApiError.badRequest(`"${n.title}" allows at most ${n.maxPracticals ?? 3} practical(s)`);
    const practicals = clampPracticals(n, asked);

    const price = priceNotice(n, new Date(), settings.feePolicy.lateFeeEnabled, practicals);
    if (!isPayablePhase(price.phase)) {
      throw ApiError.badRequest(price.phase === 'not_started' ? `"${n.title}" is not open yet` : `The payment deadline of "${n.title}" has passed. Contact the finance office`);
    }
    return {
      notice: n._id,
      title: lineTitle(n.title, practicals),
      examAmount: price.examAmount,
      practicals,
      practicalAmount: price.practicalAmount,
      practicalLateFee: price.practicalLateFee,
      baseAmount: price.baseAmount,
      lateFee: price.lateFee,
      total: price.total,
    };
  });
  const totalAmount = items.reduce((s, i) => s + i.total, 0);
  return { items, totalAmount, currency: settings.feePolicy.currency };
};

// The receipt shows the exam fee and the practical fees on separate rows, even though they were ONE payment.
const receiptLines = (items) =>
  items.flatMap((i) => {
    if (!(i.practicals > 0)) return [{ title: i.title, baseAmount: i.baseAmount, lateFee: i.lateFee, total: i.total }];
    const examLate = i.lateFee - (i.practicalLateFee || 0);
    const plain = i.title.replace(/ \((?:exam )?fee \+ \d+ practicals?\)$/, '');
    return [
      { title: `${plain} (fee)`, baseAmount: i.examAmount, lateFee: examLate, total: i.examAmount + examLate },
      { title: `Practical fee x ${i.practicals}`, baseAmount: i.practicalAmount, lateFee: i.practicalLateFee || 0, total: i.practicalAmount + (i.practicalLateFee || 0) },
    ];
  });

const issueReceipt = async (payment) => {
  const year = new Date().getFullYear();
  const seq = await Counter.next(`receipt-${year}`);
  const receiptNumber = `RCP-${year}-${String(seq).padStart(6, '0')}`;
  const [profile, student, dept, collector] = await Promise.all([
    StudentProfile.findOne({ user: payment.student }).select('rollNumber'),
    User.findById(payment.student).select('name'),
    Department.findById(payment.department).select('name'),
    payment.collectedBy ? User.findById(payment.collectedBy).select('name') : null,
  ]);
  await FeeReceipt.create({
    payment: payment._id,
    receiptNumber,
    student: payment.student,
    studentName: student?.name,
    rollNumber: profile?.rollNumber,
    departmentName: dept?.name,
    lines: receiptLines(payment.items),
    totalAmount: payment.totalAmount,
    currency: payment.currency,
    method: payment.method,
    collectedBy: collector?.name,
    bankReference: payment.method === 'bank' ? payment.bank?.reference : undefined,
  });
  return receiptNumber;
};

const HOW = { gateway: 'online payment', manual: 'payment at the university office', bank: 'bank transfer' };

// THE ONLY place a payment becomes "paid". Callers must have verified the payment first: with the gateway for an online
// payment, with the bank statement for a bank transfer, or be an authorised employee for office collection.
// The status change is one atomic update, so a webhook and a browser redirect arriving together cannot create two receipts.
export const markPaid = async (paymentId, extra = {}) => {
  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.FAILED] } },
    { $set: { status: PAYMENT_STATUS.PAID, paidAt: new Date(), ...extra }, $unset: { failureReason: '' } },
    { new: true }
  );
  if (!payment) return Payment.findById(paymentId); // already processed: nothing more to do

  payment.receiptNumber = await issueReceipt(payment);
  await payment.save();
  await FeeCart.updateOne({ student: payment.student }, { $pull: { items: { notice: { $in: payment.items.map((i) => i.notice) } } } });

  // The student is told the same way whether they paid online, by bank transfer or at the office.
  const what = payment.items.map((i) => i.title).join(', ');
  const message = `Your ${HOW[payment.method] || 'payment'} of ${payment.currency} ${payment.totalAmount} was received. Receipt ${payment.receiptNumber}. ${what}.`;
  await notifyUsers([payment.student], { title: 'Payment received', message, type: 'payment', link: '/fees' });
  smsToUser(payment.student, `Payment received: ${payment.currency} ${payment.totalAmount}. Receipt ${payment.receiptNumber}.`); // optional, never awaited
  return payment;
};

// A new checkout replaces any older unfinished one for the same student.
export const supersedePending = (studentId) =>
  Payment.updateMany(
    { student: studentId, method: 'gateway', status: PAYMENT_STATUS.PENDING },
    { status: PAYMENT_STATUS.FAILED, failureReason: 'superseded by a newer checkout' }
  );
