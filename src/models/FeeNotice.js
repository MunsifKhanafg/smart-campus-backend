import mongoose from 'mongoose';
import { FEE_TYPES, FEE_NOTICE_STATUS } from '../config/constants.js';

const feeNoticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    feeType: { type: String, enum: FEE_TYPES, default: 'examination' },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    examination: { type: mongoose.Schema.Types.ObjectId, ref: 'Examination', default: null, index: true },
    amount: { type: Number, required: true, min: 0 },
    startDate: { type: Date, required: true }, // collection opens
    dueDate: { type: Date, required: true }, // normal payment deadline (valid until the end of this day)
    lateFee: { type: Number, default: 0, min: 0 },
    lateDueDate: { type: Date, default: null }, // last day to pay WITH the late fee
    // Practical subjects. The student says how many practicals they have (0 to maxPracticals) and the fee is
    //   amount (exam fee) + practicals x practicalFee   ->   ONE amount, ONE payment.
    // The late fee works the same way: lateFee + practicals x practicalLateFee.
    practicalFee: { type: Number, default: 0, min: 0 }, // per practical
    practicalLateFee: { type: Number, default: 0, min: 0 }, // per practical, only after the normal deadline
    maxPracticals: { type: Number, default: 3, min: 0, max: 6 },
    requirements: { type: String, trim: true, maxlength: 3000, default: '' },
    requiredDocuments: [{ type: String, trim: true, lowercase: true, maxlength: 60 }],
    // Fee announcements create one notice per semester (and one more for the practical fee). They share a batch id.
    component: { type: String, enum: ['theory', 'practical', 'general'], default: 'general' },
    batch: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    batchTitle: { type: String, trim: true, maxlength: 200, default: '' },
    status: { type: String, enum: Object.values(FEE_NOTICE_STATUS), default: FEE_NOTICE_STATUS.DRAFT, index: true },
    publishedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByRole: String,
  },
  { timestamps: true }
);

feeNoticeSchema.pre('validate', function (next) {
  if (this.dueDate < this.startDate) return next(new Error('Payment deadline cannot be before the collection start date'));
  if (this.lateDueDate && this.lateDueDate <= this.dueDate) return next(new Error('Late payment deadline must be after the normal deadline'));
  if (this.lateFee > 0 && !this.lateDueDate) return next(new Error('Set a late payment deadline when a late fee is configured'));
  next();
});

export default mongoose.model('FeeNotice', feeNoticeSchema);
