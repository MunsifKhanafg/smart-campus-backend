import Payment from '../models/Payment.js';
import FeeCart from '../models/FeeCart.js';
import FeeReceipt from '../models/FeeReceipt.js';
import FeeNotice from '../models/FeeNotice.js';
import ExaminationAdmission from '../models/ExaminationAdmission.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { buildPaymentItems, markPaid, supersedePending } from '../services/paymentService.js';
import { buildRequirements, assertRequirementsMet, resolvePhone } from '../services/requirementService.js';
import { createCheckout, retrieveCheckout, verifyStripeSignature, refundPayment, providerName } from '../services/paymentGateway.js';
import { renderReceipt } from '../services/pdfService.js';
import { ROLES, PAYMENT_STATUS, REVIEW_STATUS } from '../config/constants.js';

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const loadOwnPayment = async (id, user) => {
  const p = await Payment.findById(id);
  if (!p || String(p.student) !== String(user._id)) throw ApiError.notFound('Payment not found');
  return p;
};

// ---------- Student: checkout ----------
export const checkout = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile) throw ApiError.notFound('Your student profile has not been created yet');
  const cart = await FeeCart.findOne({ student: req.user._id });
  if (!cart?.items.length) throw ApiError.badRequest('Your cart is empty');

  // The student fills the requirements BEFORE paying: mobile number (for the confirmation SMS) and the documents the fees ask
  // for. They are stored on the payment, in the finance officer's file.
  const cartNotices = await FeeNotice.find({ _id: { $in: cart.items.map((i) => i.notice) } });
  const phone = await resolvePhone(req.user._id, req.body?.phone);
  const requirements = await buildRequirements({ studentId: req.user._id, notices: cartNotices, phone });
  assertRequirementsMet(requirements);

  // Prices are calculated here, on the server, from the fee notices. Nothing is taken from the browser.
  const { items, totalAmount, currency } = await buildPaymentItems({
    studentId: req.user._id,
    profile,
    lines: cart.items.map((i) => ({ notice: i.notice, practicals: i.practicals })),
  });
  await supersedePending(req.user._id);

  const payment = await Payment.create({
    student: req.user._id,
    department: profile.department,
    items,
    totalAmount,
    currency,
    method: 'gateway',
    provider: providerName() === 'stripe' ? 'stripe' : 'mock',
    requirements,
  });
  const checkoutInfo = await createCheckout({ payment, studentEmail: req.user.email });
  payment.provider = checkoutInfo.provider;
  payment.gatewayRef = checkoutInfo.gatewayRef;
  await payment.save();

  logAudit(req, 'payment.checkout', 'Payment', payment._id, { total: totalAmount, provider: payment.provider });
  sendSuccess(res, { paymentId: payment._id, provider: payment.provider, checkoutUrl: checkoutInfo.checkoutUrl, totalAmount, currency }, 'Checkout created', 201);
});

// After the gateway redirects the student back, the server asks the gateway whether it was REALLY paid.
export const verifyPayment = asyncHandler(async (req, res) => {
  const payment = await loadOwnPayment(req.params.id, req.user);
  if (payment.status === PAYMENT_STATUS.PAID) return sendSuccess(res, payment, 'Payment confirmed');
  if (payment.provider !== 'stripe') throw ApiError.badRequest('This payment is confirmed by the gateway simulator, not by this endpoint');

  const info = await retrieveCheckout(payment);
  if (!info?.paid) return sendSuccess(res, payment, 'The gateway has not confirmed this payment yet');
  if (info.amount !== payment.totalAmount || info.currency !== payment.currency.toUpperCase()) {
    payment.failureReason = 'Gateway amount did not match the expected amount';
    await payment.save();
    throw ApiError.conflict('The paid amount does not match. Please contact the finance office');
  }
  const paid = await markPaid(payment._id, { gatewayPaymentId: info.paymentIntent });
  sendSuccess(res, paid, 'Payment confirmed');
});

// Gateway -> our server. Authenticated ONLY by the signature, never by a login.
export const stripeWebhook = asyncHandler(async (req, res) => {
  const raw = req.body.toString('utf8'); // express.raw() keeps the exact bytes the signature was made from
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) {
    throw ApiError.badRequest('Invalid signature');
  }
  const event = JSON.parse(raw);
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const s = event.data.object;
    const payment = await Payment.findOne({ gatewayRef: s.id });
    if (payment && s.payment_status === 'paid' && s.amount_total / 100 === payment.totalAmount && String(s.currency).toUpperCase() === payment.currency.toUpperCase()) {
      await markPaid(payment._id, { gatewayPaymentId: s.payment_intent });
    }
  }
  res.json({ received: true });
});

// Development gateway simulator: plays the role of "the gateway confirms the payment".
export const mockConfirm = asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production' || providerName() !== 'mock') throw ApiError.forbidden('The payment simulator is disabled');
  const payment = await loadOwnPayment(req.params.id, req.user);
  if (payment.provider !== 'mock') throw ApiError.badRequest('Not a simulated payment');
  if (payment.status === PAYMENT_STATUS.FAILED && payment.failureReason?.startsWith('superseded')) {
    throw ApiError.conflict('This checkout was replaced by a newer one');
  }
  const paid = await markPaid(payment._id, { gatewayPaymentId: `mock_pi_${payment._id}` });
  sendSuccess(res, paid, 'Simulated payment confirmed');
});

export const myPayments = asyncHandler(async (req, res) => {
  // A bank transfer that the finance office rejected stays visible, with the reason, so the student knows what to do.
  const payments = await Payment.find({
    student: req.user._id,
    $or: [{ status: { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.PENDING] } }, { method: 'bank', status: PAYMENT_STATUS.FAILED }],
  }).sort({ createdAt: -1 });
  sendSuccess(res, payments);
});

export const getMyPayment = asyncHandler(async (req, res) => sendSuccess(res, await loadOwnPayment(req.params.id, req.user)));

// ---------- Finance / head ----------
export const listPayments = asyncHandler(async (req, res) => {
  const { status, department, search, from, to } = req.query;
  const filter = { status: status || { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.REFUNDED] } }; // only verified records by default
  if (department) filter.department = department;
  if (from || to) filter.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  if (search) {
    const rx = new RegExp(escapeRx(search), 'i');
    const profiles = await StudentProfile.find({ rollNumber: rx }).select('user');
    const users = await User.find({ role: ROLES.STUDENT, name: rx }).select('_id');
    filter.student = { $in: [...profiles.map((p) => p.user), ...users.map((u) => u._id)] };
  }
  const payments = await Payment.find(filter).sort({ createdAt: -1 }).limit(300).populate('student', 'name email').populate('collectedBy', 'name').lean();
  const profiles = await StudentProfile.find({ user: { $in: payments.map((p) => p.student?._id) } }).select('user rollNumber').lean();
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, payments.map((p) => ({ ...p, rollNumber: roll.get(String(p.student?._id)) || '' })));
});

// An authorised employee takes money at the office. Collector, amount, receipt number and date are all recorded.
// The student gets the same "Payment received" notification as after an online payment.
export const manualPayment = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.body.student });
  if (!profile) throw ApiError.notFound('Student not found');
  const lines = req.body.items || req.body.notices.map((n) => ({ notice: n, practicals: 0 }));
  const { items, totalAmount, currency } = await buildPaymentItems({ studentId: profile.user, profile, lines });

  // The officer fills the same requirements form for the student at the counter: the mobile number for the SMS, and a tick for
  // every required document the student handed over in person.
  const notices = await FeeNotice.find({ _id: { $in: lines.map((l) => l.notice) } });
  const phone = await resolvePhone(profile.user, req.body.phone);
  const requirements = await buildRequirements({ studentId: profile.user, notices, phone, receivedAtOffice: req.body.receivedDocuments || [], filledBy: req.user._id });
  assertRequirementsMet(requirements, true);

  // A bank / JazzCash / EasyPaisa payment brought to the office needs its transaction number, and one transaction cannot be
  // recorded twice (not here, and not as a transfer a student submitted online).
  const paidVia = req.body.paidVia || 'cash';
  if (paidVia !== 'cash') {
    const same = new RegExp(`^${escapeRx(req.body.reference)}$`, 'i');
    if (await Payment.exists({ status: { $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PAID] }, $or: [{ 'office.reference': same }, { 'bank.reference': same }] })) {
      throw ApiError.conflict('This transaction number is already recorded for another payment');
    }
  }

  const payment = await Payment.create({
    student: profile.user,
    department: profile.department,
    items,
    totalAmount,
    currency,
    method: 'manual',
    provider: null,
    requirements,
    collectedBy: req.user._id,
    manualNote: req.body.note,
    office: { paidVia, reference: req.body.reference || '', payerName: req.body.payerName || '', payerPhone: req.body.payerPhone || '' },
  });
  const paid = await markPaid(payment._id);
  logAudit(req, 'payment.manual', 'Payment', paid._id, { total: totalAmount, student: String(profile.user), receipt: paid.receiptNumber });
  sendSuccess(res, paid, 'Payment recorded and receipt issued', 201);
});

export const refund = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.status !== PAYMENT_STATUS.PAID) throw ApiError.badRequest('Only paid payments can be refunded');

  const gatewayRefundId = await refundPayment(payment); // throws if the gateway refuses, so we never mark it refunded by mistake
  payment.status = PAYMENT_STATUS.REFUNDED;
  payment.refund = { at: new Date(), by: req.user._id, reason: req.body.reason, gatewayRefundId };
  await payment.save();
  // A refunded exam fee means the student no longer meets the admission rule. An already APPROVED admission for that
  // exam is reopened with a clear reason, so the admit card cannot be used for a fee that was given back.
  const examIds = await FeeNotice.find({ _id: { $in: payment.items.map((i) => i.notice) }, examination: { $ne: null } }).distinct('examination');
  if (examIds.length) {
    const reopened = await ExaminationAdmission.updateMany(
      { student: payment.student, examination: { $in: examIds }, status: REVIEW_STATUS.APPROVED },
      { status: REVIEW_STATUS.REQUIRES_CORRECTION, reason: 'Your examination fee was refunded. Pay the fee again and request admission to receive your admit card' }
    );
    if (reopened.modifiedCount) {
      await notifyUsers([payment.student], { title: 'Examination admission withdrawn', message: 'Your examination fee was refunded, so your admission needs to be requested again after you pay.', type: 'admission', link: '/exams' });
    }
  }
  await notifyUsers([payment.student], { title: 'Payment refunded', message: `Receipt ${payment.receiptNumber} was refunded: ${req.body.reason}`, type: 'payment', link: '/fees' });
  logAudit(req, 'payment.refund', 'Payment', payment._id, { reason: req.body.reason, total: payment.totalAmount });
  sendSuccess(res, payment, 'Refund recorded');
});

export const downloadReceipt = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (req.user.role === ROLES.STUDENT && String(payment.student) !== String(req.user._id)) throw ApiError.forbidden();
  const receipt = await FeeReceipt.findOne({ payment: payment._id });
  if (!receipt) throw ApiError.notFound('No receipt has been issued for this payment');
  renderReceipt(res, { settings: await UniversitySettings.getSettings(), receipt });
});
