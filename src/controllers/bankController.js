import Payment from '../models/Payment.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { toFileDocs, sendStored } from '../middleware/upload.js';
import { smsToUser } from '../services/smsService.js';
import { buildPaymentItems, markPaid } from '../services/paymentService.js';
import { ROLES, PAYMENT_STATUS } from '../config/constants.js';

// Way 2 of paying: the student sends the money to the university bank account and submits the transfer details with a
// photo of the bank slip. The payment stays PENDING (it is NOT paid) until a finance officer has checked the bank
// statement and presses "Received". Only then does it become paid, a receipt is issued and the student is told
// (notification + optional SMS), exactly like an online payment.
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The account the student sends money to (only for logged-in users, never public).
export const bankInfo = asyncHandler(async (_req, res) => {
  const s = (await UniversitySettings.getSettings()).toObject();
  sendSuccess(res, { ...s.bankAccount, currency: s.feePolicy.currency });
});

// Student: submit a transfer. Prices are calculated here, on the server; the browser only says WHICH fees (and how many practicals).
export const bankSubmit = uploadHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile) throw ApiError.notFound('Your student profile has not been created yet');

  const settings = (await UniversitySettings.getSettings()).toObject();
  if (!settings.bankAccount?.accountNumber && !settings.bankAccount?.iban) {
    throw ApiError.badRequest('The university has not added its bank account yet. Please pay online or at the office');
  }
  const proof = req.files?.[0];
  if (!proof) throw ApiError.badRequest('Please attach a photo or PDF of the bank slip');

  let lines;
  try { lines = JSON.parse(req.body.items); } catch { throw ApiError.badRequest('The list of fees is not valid'); }
  if (!Array.isArray(lines) || !lines.length || lines.length > 10) throw ApiError.badRequest('Choose between 1 and 10 fees');
  lines = lines.map((l) => ({ notice: String(l.notice), practicals: Number(l.practicals) || 0 }));

  const reference = req.body.reference;
  const dup = await Payment.exists({
    method: 'bank',
    'bank.reference': new RegExp(`^${escapeRx(reference)}$`, 'i'),
    status: { $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PAID] },
  });
  if (dup) throw ApiError.conflict('This transaction reference was already submitted');

  const { items, totalAmount, currency } = await buildPaymentItems({ studentId: req.user._id, profile, lines });
  const payment = await Payment.create({
    student: req.user._id,
    department: profile.department,
    items,
    totalAmount,
    currency,
    method: 'bank',
    provider: null,
    status: PAYMENT_STATUS.PENDING,
    bank: {
      bankName: req.body.bankName,
      reference,
      transferDate: req.body.transferDate,
      note: req.body.note || '',
      proof: toFileDocs([proof])[0],
      submittedAt: new Date(),
    },
  });

  const officers = await User.find({ role: ROLES.FINANCE_OFFICER, isActive: true }).select('_id').lean();
  await notifyUsers(officers.map((o) => o._id), {
    title: 'Bank transfer to check',
    message: `${req.user.name} (${profile.rollNumber}) says they sent ${currency} ${totalAmount}. Reference ${reference}.`,
    type: 'payment',
    link: '/finance',
  });
  logAudit(req, 'payment.bank_submit', 'Payment', payment._id, { total: totalAmount, reference });
  sendSuccess(res, payment, 'Your transfer was sent to the finance office. You will be notified when it is received', 201);
});

// Finance officer (and the head, read only): transfers waiting to be checked, or already processed.
export const bankList = asyncHandler(async (req, res) => {
  const { status = 'pending', search } = req.query;
  const filter = { method: 'bank' };
  if (status !== 'all') filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRx(search), 'i');
    const [profiles, users] = await Promise.all([
      StudentProfile.find({ rollNumber: rx }).select('user'),
      User.find({ role: ROLES.STUDENT, $or: [{ name: rx }, { email: rx }] }).select('_id'),
    ]);
    filter.student = { $in: [...profiles.map((p) => p.user), ...users.map((u) => u._id)] };
  }
  const payments = await Payment.find(filter).sort({ createdAt: -1 }).limit(200)
    .populate('student', 'name email').populate('bank.reviewedBy', 'name').lean();
  const profiles = await StudentProfile.find({ user: { $in: payments.map((p) => p.student?._id) } }).select('user rollNumber').lean();
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, payments.map((p) => ({ ...p, rollNumber: roll.get(String(p.student?._id)) || '' })));
});

// "Received": the officer saw the money in the bank statement. receivedAmount (optional) is what the statement shows.
export const bankConfirm = asyncHandler(async (req, res) => {
  const p = await Payment.findById(req.params.id);
  if (!p || p.method !== 'bank') throw ApiError.notFound('Bank transfer not found');
  if (p.status !== PAYMENT_STATUS.PENDING) throw ApiError.conflict('This transfer was already processed');
  const received = req.body.receivedAmount;
  if (received !== undefined && received !== p.totalAmount) {
    throw ApiError.badRequest(`The bank shows ${received} but ${p.totalAmount} is due. Reject it with a reason, or ask the student to send the difference`);
  }
  const extra = { collectedBy: req.user._id, 'bank.reviewedBy': req.user._id, 'bank.reviewedAt': new Date() };
  if (req.body.note) extra.manualNote = req.body.note;
  const paid = await markPaid(p._id, extra); // issues the receipt and notifies the student (notification + optional SMS)
  logAudit(req, 'payment.bank_confirm', 'Payment', paid._id, { total: paid.totalAmount, receipt: paid.receiptNumber });
  sendSuccess(res, paid, `Transfer received. Receipt ${paid.receiptNumber}. The student was notified`);
});

// "Not received" / wrong details: the student is told why and can submit again.
export const bankReject = asyncHandler(async (req, res) => {
  const reason = req.body.reason;
  const p = await Payment.findOneAndUpdate(
    { _id: req.params.id, method: 'bank', status: PAYMENT_STATUS.PENDING },
    { $set: { status: PAYMENT_STATUS.FAILED, failureReason: reason, 'bank.rejectReason': reason, 'bank.reviewedBy': req.user._id, 'bank.reviewedAt': new Date() } },
    { new: true }
  );
  if (!p) throw ApiError.conflict('This transfer was already processed or does not exist');
  await notifyUsers([p.student], {
    title: 'Bank transfer not accepted',
    message: `Your transfer of ${p.currency} ${p.totalAmount} (ref ${p.bank?.reference}) was not accepted: ${reason}. You can submit it again or pay at the office.`,
    type: 'payment',
    link: '/fees',
  });
  smsToUser(p.student, `Your bank transfer of ${p.currency} ${p.totalAmount} was not accepted: ${reason}`);
  logAudit(req, 'payment.bank_reject', 'Payment', p._id, { reason });
  sendSuccess(res, p, 'Transfer rejected. The student was notified');
});

// The slip the student uploaded: the student who sent it, the finance office and the head.
export const bankProof = asyncHandler(async (req, res) => {
  const p = await Payment.findById(req.params.id);
  if (!p || p.method !== 'bank' || !p.bank?.proof?.storedName) throw ApiError.notFound('Proof not found');
  if (req.user.role === ROLES.STUDENT && String(p.student) !== String(req.user._id)) throw ApiError.forbidden();
  sendStored(res, 'bank-proofs', p.bank.proof);
});
