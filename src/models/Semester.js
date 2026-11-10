import mongoose from 'mongoose';
import { SEMESTER_STATUS } from '../config/constants.js';
import { computeSemesterEnd, DEFAULT_SEMESTER_WEEKS } from '../services/teachingCalendar.js';

const semesterSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 }, // e.g. "BSCS Semester 3 - Fall 2026"
    number: { type: Number, required: true, min: 1, max: 12 },
    academicYear: { type: String, required: true, match: [/^\d{4}-\d{4}$/, 'Use format 2025-2026'] },
    startDate: { type: Date, required: true },
    // How long the semester lasts, in weeks. With endDateManual = false the end date is always start date + this duration.
    durationWeeks: { type: Number, min: 1, max: 52, default: DEFAULT_SEMESTER_WEEKS },
    endDate: { type: Date, required: true },
    // true  = an administrator typed the end date (also the value for semesters that existed before this field was added,
    //         so their saved end dates are never changed behind anybody's back);
    // false = the end date is calculated from the start date and durationWeeks and follows every change of them.
    endDateManual: { type: Boolean, default: true },
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
  if (this.startDate) {
    if (this.isNew) {
      if (!this.endDate || this.endDateManual === false) {
        this.endDate = computeSemesterEnd(this.startDate, this.durationWeeks);
        this.endDateManual = false;
      }
    } else {
      const recalc = this.isModified('startDate') || this.isModified('durationWeeks') || this.isModified('endDateManual');
      if (this.isModified('endDate') && !recalc) this.endDateManual = true; // an administrator changed the end date by hand
      else if (!this.endDateManual && recalc) this.endDate = computeSemesterEnd(this.startDate, this.durationWeeks);
    }
  }
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    return next(new Error('Semester end date must be after the start date'));
  }
  next();
});

// When the dates of an existing semester change, remember the old ones: the course dates that followed them must follow the new ones.
semesterSchema.pre('save', async function (next) {
  try {
    this.$locals.datesChanged = false;
    if (!this.isNew && (this.isModified('startDate') || this.isModified('endDate'))) {
      this.$locals.oldDates = await this.constructor.findById(this._id).select('startDate endDate').lean();
      this.$locals.datesChanged = true;
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Keep course dates and the dated course contents in step with the new semester dates (see services/scheduleSync.js).
// A failure here must never make the semester save fail, so it is only logged.
semesterSchema.post('save', async function (doc) {
  if (!doc.$locals?.datesChanged) return;
  try {
    const { syncSemesterSchedule } = await import('../services/scheduleSync.js');
    await syncSemesterSchedule(doc, doc.$locals.oldDates);
  } catch (err) {
    console.error('Semester schedule sync failed:', err.message);
  }
});

export default mongoose.model('Semester', semesterSchema);
