import mongoose from 'mongoose';

// A student's request to be away. Decided by the HOD of the student's department (the principal can decide too).
// Dates are plain calendar days ("YYYY-MM-DD") so a leave never shifts because of a time zone.
const studentLeaveSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    toDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    type: { type: String, enum: ['sick', 'family', 'other'], default: 'sick' },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 600 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { timestamps: true }
);

studentLeaveSchema.index({ student: 1, fromDate: 1, toDate: 1 });

studentLeaveSchema.pre('validate', function (next) {
  if (this.fromDate && this.toDate && this.toDate < this.fromDate) return next(new Error('The last day of the leave cannot be before the first day'));
  next();
});

export default mongoose.model('StudentLeave', studentLeaveSchema);
