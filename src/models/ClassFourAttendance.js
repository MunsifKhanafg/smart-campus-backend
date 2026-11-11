import mongoose from 'mongoose';

// One row per Class IV staff member per day.
const classFourAttendanceSchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassFourStaff', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    status: { type: String, enum: ['present', 'absent', 'leave'], required: true },
    note: { type: String, trim: true, maxlength: 200, default: '' },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
classFourAttendanceSchema.index({ staff: 1, date: 1 }, { unique: true });

export default mongoose.model('ClassFourAttendance', classFourAttendanceSchema);
