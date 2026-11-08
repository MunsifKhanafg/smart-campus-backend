import mongoose from 'mongoose';

// An account the students can pay into: a bank account, a JazzCash wallet or an EasyPaisa wallet.
// The finance officer adds, edits and switches them off. Students only ever see the ACTIVE ones.
// An account that already received payments is never deleted (it is only switched off), so old receipts stay explainable.
const paymentAccountSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['bank', 'jazzcash', 'easypaisa'], required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 }, // name of the account holder
    number: { type: String, required: true, trim: true, maxlength: 40 }, // account number, or the mobile number of the wallet
    bankName: { type: String, trim: true, maxlength: 80, default: '' }, // bank accounts only
    iban: { type: String, trim: true, maxlength: 40, default: '' },
    branch: { type: String, trim: true, maxlength: 120, default: '' },
    instructions: { type: String, trim: true, maxlength: 600, default: '' },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// The same number cannot be added twice for the same kind of account.
paymentAccountSchema.index({ type: 1, number: 1 }, { unique: true });

export default mongoose.model('PaymentAccount', paymentAccountSchema);
