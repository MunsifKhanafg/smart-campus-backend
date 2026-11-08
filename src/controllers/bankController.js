import { z } from 'zod';
import Payment from '../models/Payment.js';
import PaymentAccount from '../models/PaymentAccount.js';
import FeeCart from '../models/FeeCart.js';
import FeeNotice from '../models/FeeNotice.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { toFileDocs, sendStored } from '../middleware/upload.js';
import { objectId } from '../validators/validate.js';
import { buildPaymentItems, markPaid } from '../services/paymentService.js';
import { buildRequirements, assertRequirementsMet, resolvePhone } from '../services/requirementService.js';
import { accountLabel, transferDetails } from '../services/accountService.js';
import { smsToUser } from '../services/smsService.js';
import { ROLES, PAYMENT_STATUS } from '../config/constants.js';

// ==========================================================================================================
// Payment by TRANSFER: a bank account, JazzCash or EasyPaisa (method = "bank" in the database).
//   The finance officer keeps the list of accounts (Finance Desk > Payment accounts, see accountController.js).
//   1. The student fills the requirements (mobile number + required documents), sends the money to one of the accounts and
//      submits the transfer details with a photo of the slip. A payment is created with status "pending". Nothing is paid yet.
//   2. The finance officer checks the statement, then presses Received (the payment becomes paid, a receipt is issued, the
//      student gets a notification and an SMS) or Reject with a reason (the student is told why and can pay again).
// The amount is calculated by the server when the student submits (exam fee + practicals x practical fee + late fee, if any),
// so a transfer sent before the deadline is not punished if the officer confirms it a day later.
// ==========================================================================================================

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DAY = 24 * 60 * 60 * 1000;
const PROOF_FOLDER = 'bank-proofs';

// The accounts a student can pay into (the finance officer also sees the switched-off ones).
export { listAccounts as bankInfo } from './accountController.js';

const itemsSchema = z.array(z.object({ notice: objectId, practicals: z.coerce.number().int().min(0).max(6).default(0) })).min(1).max(10);

// ---------- student: submit a transfer ----------
export const bankSubmit = uploadHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile) throw ApiError.notFound('Your student profile has not been created yet');

  const account = await PaymentAccount.findOne({ _id: req.body.accountId, active: true });
  if (!account) throw ApiError.badRequest('Choose one of the university accounts shown on the page');
  const sender = transferDetails(account, req.body); // bank name for a bank account, the mobile number for a wallet

  let raw;
  try { raw = JSON.parse(req.body.items); } catch { throw ApiError.badRequest('The selected fees could not be read'); }
  const parsed = itemsSchema.safeParse(raw);
  if (!parsed.success) throw ApiError.badRequest('The selected fees are not valid');

  const file = req.files?.[0];
  if (!file) throw ApiError.badRequest('Attach a photo or PDF of the slip or the transfer screenshot');
  if (req.body.transferDate.getTime() > Date.now() + DAY) throw ApiError.badRequest('The transfer date cannot be in the future');

  // The same reference (TID) cannot be used twice, otherwise one transfer could be claimed for two payments.
  const used = await Payment.findOne({
    method: 'bank',
    'bank.reference': new RegExp(`^${escapeRx(req.body.reference)}$`, 'i'),
    status: { $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PAID] },
  }).select('_id');
  if (used) throw ApiError.conflict('This transaction reference was already submitted');

  // 1) the requirements form: mobile number + documents. Kept in the finance officer's file.
  const phone = await resolvePhone(req.user._id, req.body.phone);
  const notices = await FeeNotice.find({ _id: { $in: parsed.data.map((l) => l.notice) } });
  const requirements = await buildRequirements({ studentId: req.user._id, notices, phone });
  assertRequirementsMet(requirements);

  // 2) the amount, calculated here
  const { items, totalAmount, currency } = await buildPaymentItems({ studentId: req.user._id, profile, lines: parsed.data });

  const payment = await Payment.create({
    student: req.user._id,
    department: profile.department,
    items,
    totalAmount,
    currency,
    method: 'bank',
    provider: null,
    requirements,
    bank: {
      channel: account.type,
      accountId: account._id,
      accountLabel: accountLabel(account),
      bankName: sender.bankName,
      senderNumber: sender.senderNumber,
      reference: req.body.reference,
      transferDate: req.body.transferDate,
      note: req.body.note || '',
      proof: toFileDocs([file])[0],
      submittedAt: new Date(),
    },
  });
  // These fees now wait for the finance office, so they leave the cart.
  await FeeCart.updateOne({ student: req.user._id }, { $pull: { items: { notice: { $in: items.map((i) => i.notice) } } } });

  await notifyUsers([req.user._id], {
    title: 'Transfer received for checking',
    message: `We received your transfer details (${currency} ${totalAmount}, reference ${payment.bank.reference}). The finance office will check it. You will get a notification and an SMS.`,
    type: 'payment',
    link: '/fees',
  });
  const officers = await User.find({ role: ROLES.FINANCE_OFFICER, isActive: true }).distinct('_id');
  await notifyUsers(officers, {
    title: 'Transfer to verify',
    message: `${req.user.name} (${profile.rollNumber}) sent ${currency} ${totalAmount} to ${payment.bank.accountLabel}, reference ${payment.bank.reference}.`,
    type: 'payment',
    link: '/finance',
  });

  logAudit(req, 'payment.bank_submit', 'Payment', payment._id, { total: totalAmount, reference: payment.bank.reference, channel: account.type });
  sendSuccess(res, payment, 'Your transfer was submitted. You will be notified when the finance office confirms it', 201);
});

// ---------- finance officer: review ----------
export const bankList = asyncHandler(async (req, res) => {
  const { status, search } = req.query;
  const filter = { method: 'bank' };
  if (status !== 'all') filter.status = { pending: PAYMENT_STATUS.PENDING, paid: PAYMENT_STATUS.PAID, failed: PAYMENT_STATUS.FAILED }[status];
  if (search) {
    const rx = new RegExp(escapeRx(search), 'i');
    const [profiles, users] = await Promise.all([
      StudentProfile.find({ rollNumber: rx }).select('user'),
      User.find({ role: ROLES.STUDENT, $or: [{ name: rx }, { email: rx }] }).select('_id'),
    ]);
    filter.$or = [
      { student: { $in: [...profiles.map((p) => p.user), ...users.map((u) => u._id)] } },
      { 'bank.reference': rx },
      { 'bank.senderNumber': rx },
    ];
  }
  const payments = await Payment.find(filter)
    .sort({ 'bank.submittedAt': 1, createdAt: 1 }) // the oldest waiting transfer first
    .limit(300)
    .populate('student', 'name email phone')
    .populate('collectedBy', 'name')
    .lean();
  const profiles = await StudentProfile.find({ user: { $in: payments.map((p) => p.student?._id) } }).select('user rollNumber').lean();
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, payments.map((p) => ({ ...p, rollNumber: roll.get(String(p.student?._id)) || '' })));
});

const loadBank = async (id) => {
  const p = await Payment.findOne({ _id: id, method: 'bank' });
  if (!p) throw ApiError.notFound('Transfer not found');
  return p;
};

// "Received": the officer saw the money on the statement. The payment becomes paid, the receipt is issued and the student gets
// the notification and the SMS. receivedAmount is optional; when given it must match what the student owes.
export const bankConfirm = asyncHandler(async (req, res) => {
  const p = await loadBank(req.params.id);
  if (p.status !== PAYMENT_STATUS.PENDING) throw ApiError.conflict('This transfer was already processed');
  const { receivedAmount, note } = req.body;
  if (receivedAmount !== undefined && Math.abs(receivedAmount - p.totalAmount) > 0.009) {
    throw ApiError.badRequest(`The student has to pay ${p.currency} ${p.totalAmount} but you entered ${p.currency} ${receivedAmount}. Reject the transfer and ask the student to send the correct amount`);
  }
  const extra = { collectedBy: req.user._id, 'bank.reviewedBy': req.user._id, 'bank.reviewedAt': new Date() };
  if (note) extra.manualNote = note;
  const paid = await markPaid(p._id, extra);
  logAudit(req, 'payment.bank_confirm', 'Payment', p._id, { total: p.totalAmount, reference: p.bank?.reference, receipt: paid.receiptNumber });
  sendSuccess(res, paid, 'Payment received. The receipt was issued and the student was notified');
});

export const bankReject = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const p = await Payment.findOneAndUpdate(
    { _id: req.params.id, method: 'bank', status: PAYMENT_STATUS.PENDING },
    { $set: { status: PAYMENT_STATUS.FAILED, failureReason: reason, 'bank.rejectReason': reason, 'bank.reviewedBy': req.user._id, 'bank.reviewedAt': new Date() } },
    { new: true }
  );
  if (!p) throw ApiError.conflict('This transfer was already processed or does not exist');
  await notifyUsers([p.student], {
    title: 'Transfer not accepted',
    message: `Your transfer of ${p.currency} ${p.totalAmount} (reference ${p.bank?.reference}) was not accepted: ${reason}. Please check and pay again.`,
    type: 'payment',
    link: '/fees',
  });
  await smsToUser(p.student, `Your transfer (${p.bank?.reference}) was not accepted: ${reason}`);
  logAudit(req, 'payment.bank_reject', 'Payment', p._id, { reason });
  sendSuccess(res, p, 'Transfer rejected. The student was notified');
});

// The slip / screenshot: only the student who sent it and the finance office / head.
export const bankProof = asyncHandler(async (req, res) => {
  const p = await Payment.findById(req.params.id).select('student method bank');
  if (!p || p.method !== 'bank') throw ApiError.notFound('Transfer not found');
  if (req.user.role === ROLES.STUDENT && String(p.student) !== String(req.user._id)) throw ApiError.forbidden();
  const proof = p.bank?.proof;
  if (!proof?.storedName) throw ApiError.notFound('No slip was attached');
  sendStored(res, PROOF_FOLDER, proof);
});
