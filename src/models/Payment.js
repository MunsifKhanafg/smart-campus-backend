import mongoose from 'mongoose';
import { PAYMENT_STATUS } from '../config/constants.js';

// One checkout. The amounts are frozen here at the moment of checkout: original fee, late fee and total
// are preserved forever, even if the fee notice is edited later.
// NOTE: no card data is stored anywhere. The payment gateway collects the card on its own page.
//
// Three ways to pay (method):
//   gateway  the student pays online; the payment is paid only after the gateway confirms it to the server
//   bank     the student sends money to the university bank account and submits the transfer details (+ proof).
//            It stays "pending" until a finance officer checks the bank statement and presses Receive (or rejects it)
//   manual   the student comes to the office; an employee records the money they took
const paymentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    items: [
      {
        notice: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeNotice', required: true },
        title: String,
        // baseAmount = examAmount + practicalAmount. total = baseAmount + lateFee. All frozen at checkout.
        examAmount: { type: Number, default: 0 },
        practicals: { type: Number, default: 0 }, // how many practicals the student chose
        practicalAmount: { type: Number, default: 0 }, // practicals x fee per practical
        practicalLateFee: { type: Number, default: 0 }, // the part of lateFee that belongs to the practicals
        baseAmount: { type: Number, required: true },
        lateFee: { type: Number, default: 0 },
        total: { type: Number, required: true },
        _id: false,
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'PKR' },
    method: { type: String, enum: ['gateway', 'manual', 'bank'], required: true },
    provider: { type: String, enum: ['stripe', 'mock', null], default: null },
    gatewayRef: { type: String, index: true }, // checkout session id at the gateway
    gatewayPaymentId: String, // e.g. Stripe payment_intent, used for refunds
    status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING, index: true },
    paidAt: Date,
    receiptNumber: String,
    // Manual (office) collection, and the officer who pressed Receive on a bank transfer
    collectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    manualNote: { type: String, maxlength: 500 },
    // Bank transfer details typed in by the student
    bank: {
      bankName: { type: String, trim: true, maxlength: 80 },
      reference: { type: String, trim: true, maxlength: 80 }, // transaction id / reference number shown on the bank slip
      transferDate: Date,
      note: { type: String, trim: true, maxlength: 500 },
      proof: { originalName: String, storedName: String, mimeType: String, size: Number },
      submittedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: Date,
      rejectReason: { type: String, maxlength: 500 },
    },
    // Refund trail
    refund: { at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reason: String, gatewayRefundId: String },
    failureReason: String,
  },
  { timestamps: true }
);

paymentSchema.index({ 'items.notice': 1, status: 1 });
paymentSchema.index({ method: 1, status: 1, createdAt: -1 });

export default mongoose.model('Payment', paymentSchema);
