import mongoose from 'mongoose';

// Issued once, right after a payment is verified. It is a snapshot, so it never changes afterwards.
const feeReceiptSchema = new mongoose.Schema(
  {
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true, unique: true },
    receiptNumber: { type: String, required: true, unique: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    studentName: String,
    rollNumber: String,
    departmentName: String,
    lines: [{ title: String, baseAmount: Number, lateFee: Number, total: Number, _id: false }],
    totalAmount: { type: Number, required: true },
    currency: { type: String, required: true },
    method: { type: String, enum: ['gateway', 'manual', 'bank'], required: true },
    collectedBy: String, // name of the employee who collected the money / received the bank transfer
    bankReference: String, // transaction reference of a bank transfer
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model('FeeReceipt', feeReceiptSchema);
