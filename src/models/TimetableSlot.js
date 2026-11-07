import mongoose from 'mongoose';
import { DAYS } from '../config/constants.js';

const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// One class in the weekly timetable. Times are stored as "HH:MM" for display and as minutes for overlap checks.
const timetableSlotSchema = new mongoose.Schema(
  {
    timetable: { type: mongoose.Schema.Types.ObjectId, ref: 'Timetable', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    // Copied from the course. It is kept in sync when the HOD changes the course teacher.
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    room: { type: String, required: true, trim: true, uppercase: true, maxlength: 50 },
    day: { type: String, enum: DAYS, required: true },
    startTime: { type: String, required: true, match: [TIME_RX, 'Use HH:MM (24-hour)'] },
    endTime: { type: String, required: true, match: [TIME_RX, 'Use HH:MM (24-hour)'] },
    startMinutes: { type: Number, required: true },
    endMinutes: { type: Number, required: true },
  },
  { timestamps: true }
);

timetableSlotSchema.index({ teacher: 1, day: 1 });
timetableSlotSchema.index({ room: 1, day: 1 });

timetableSlotSchema.pre('validate', function (next) {
  if (TIME_RX.test(this.startTime || '') && TIME_RX.test(this.endTime || '')) {
    this.startMinutes = toMinutes(this.startTime);
    this.endMinutes = toMinutes(this.endTime);
    if (this.endMinutes <= this.startMinutes) return next(new Error('Class end time must be after the start time'));
  }
  next();
});

export default mongoose.model('TimetableSlot', timetableSlotSchema);
