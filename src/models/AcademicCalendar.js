import mongoose from 'mongoose';
import { CALENDAR_EVENT_TYPES } from '../config/constants.js';
import { NON_TEACHING_EVENT_TYPES } from '../services/teachingCalendar.js';

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

// Holidays, exams, vacations and breaks decide on which days a subject can be taught. Whenever such an entry is added,
// changed or removed, the dated course contents of the affected classes are calculated again.
// A failure here must never make the calendar save fail, so it is only logged.
const resync = async (event, previous) => {
  try {
    const touches = (e) => e && NON_TEACHING_EVENT_TYPES.includes(e.type);
    if (!touches(event) && !touches(previous)) return;
    const { syncScope } = await import('../services/scheduleSync.js');
    await syncScope({ department: event.department, semester: event.semester });
  } catch (err) {
    console.error('Calendar schedule sync failed:', err.message);
  }
};

academicCalendarSchema.pre('save', async function (next) {
  try {
    // Remember what the event was before it changed (a type change from "holiday" to "event" must also recalculate).
    this.$locals.previous = this.isNew ? null : await this.constructor.findById(this._id).select('type department semester').lean();
    next();
  } catch (err) {
    next(err);
  }
});
academicCalendarSchema.post('save', async function (doc) {
  await resync(doc, doc.$locals?.previous);
});
academicCalendarSchema.post('deleteOne', { document: true, query: false }, async function (doc) {
  await resync(doc, null);
});

export default mongoose.model('AcademicCalendar', academicCalendarSchema);
