import mongoose from 'mongoose';
import { ATTENDANCE_STATUS } from '../config/constants.js';

// One document = one class session of one course. `date` is stored at 00:00 UTC of the class day.
const attendanceSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
    date: { type: Date, required: true },
    records: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        status: { type: String, enum: Object.values(ATTENDANCE_STATUS), required: true },
        _id: false,
      },
    ],
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

attendanceSchema.index({ course: 1, date: 1 }, { unique: true });
attendanceSchema.index({ 'records.student': 1, course: 1 });

export default mongoose.model('Attendance', attendanceSchema);
