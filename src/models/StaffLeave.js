import mongoose from 'mongoose';

// A teacher's (or HOD's) request to be away. A teacher's request is decided by the HOD of the department (or the principal);
// an HOD's request is decided by the principal. Dates are the college's local days ("YYYY-MM-DD").
const staffLeaveSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    toDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    type: { type: String, enum: ['casual', 'sick', 'official', 'other'], default: 'casual' },
    // 'days'        = the normal leave for whole days.
    // 'rest_of_day' = the person ALREADY marked attendance today and asks to leave the college at leaveTime (fromDate = toDate = today).
    //                 Until it is approved the person must stay. When approved, the classes after that time are not taught: their course
    //                 contents move to the next teaching day and the mid-day attendance is not needed.
    kind: { type: String, enum: ['days', 'rest_of_day'], default: 'days', index: true },
    leaveTime: { type: String, match: /^([01]\d|2[0-3]):[0-5]\d$/, default: '' }, // "HH:MM", only for rest_of_day
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 600 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { timestamps: true }
);

staffLeaveSchema.pre('validate', function (next) {
  if (this.fromDate && this.toDate && this.toDate < this.fromDate) return next(new Error('The last day of the leave cannot be before the first day'));
  next();
});

export default mongoose.model('StaffLeave', staffLeaveSchema);
