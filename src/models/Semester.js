import mongoose from 'mongoose';
import { SEMESTER_STATUS } from '../config/constants.js';
import { DEFAULT_SEMESTER_WEEKS } from '../services/semesterDates.js';

const semesterSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 }, // e.g. "BSCS Semester 3 - Fall 2026"
    number: { type: Number, required: true, min: 1, max: 12 },
    academicYear: { type: String, required: true, match: [/^\d{4}-\d{4}$/, 'Use format 2025-2026'] },
    startDate: { type: Date, required: true },
    // The end date is calculated from the start date and this duration (see services/semesterDates.js) ...
    durationWeeks: { type: Number, min: 1, max: 52, default: DEFAULT_SEMESTER_WEEKS },
    endDate: { type: Date, required: true },
    // ... unless an administrator typed it by hand (true).
    endDateManual: { type: Boolean, default: false },
    status: {
      type: String,
      enum: Object.values(SEMESTER_STATUS),
      default: SEMESTER_STATUS.UPCOMING,
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Several semesters can run at the same time, but a name cannot repeat inside one department and year.
semesterSchema.index({ department: 1, academicYear: 1, name: 1 }, { unique: true });

semesterSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    return next(new Error('Semester end date must be after the start date'));
  }
  next();
});

export default mongoose.model('Semester', semesterSchema);
