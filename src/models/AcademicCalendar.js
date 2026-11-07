import mongoose from 'mongoose';
import { CALENDAR_EVENT_TYPES } from '../config/constants.js';

// Academic calendar entries. department = null means "university-wide" (set by the University Head).
const academicCalendarSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    type: { type: String, enum: CALENDAR_EVENT_TYPES, required: true, index: true },
    startDate: { type: Date, required: true, index: true },
    endDate: { type: Date, required: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    // Optional: limits the event to one semester (for example a midterm of semester 3 only).
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

academicCalendarSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    return next(new Error('Event end date cannot be before its start date'));
  }
  next();
});

export default mongoose.model('AcademicCalendar', academicCalendarSchema);
