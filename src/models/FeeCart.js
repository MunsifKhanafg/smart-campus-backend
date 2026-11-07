import mongoose from 'mongoose';

// The student's cart. It only remembers WHICH fee notices were chosen and how many practicals the student has for each.
// Prices (and late fees) are always recalculated by the server at checkout, so a stale cart can never underpay.
const feeCartSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: [
      {
        notice: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeNotice', required: true },
        practicals: { type: Number, default: 0, min: 0, max: 6 },
        addedAt: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model('FeeCart', feeCartSchema);
