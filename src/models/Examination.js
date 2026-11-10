import mongoose from 'mongoose';
import { EXAM_TYPES, EXAM_STATUS } from '../config/constants.js';

const TIME_RX = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// One paper (subject) of the date sheet. Its _id identifies the paper in marks and admit cards.
const paperSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
  date: { type: Date, required: true }, // 00:00 UTC of the exam day
  startTime: { type: String, required: true, match: TIME_RX },
  endTime: { type: String, required: true, match: TIME_RX },
  startMinutes: Number,
  endMinutes: Number,
  room: { type: String, required: true, trim: true, uppercase: true, maxlength: 50 },
  maxMarks: { type: Number, required: true, min: 1, max: 1000 },
  passingMarks: { type: Number, required: true, min: 0 },
});

paperSchema.pre('validate', function (next) {
  if (this.startTime && this.endTime) {
    this.startMinutes = toMin(this.startTime);
    this.endMinutes = toMin(this.endTime);
    if (this.endMinutes <= this.startMinutes) return next(new Error('Paper end time must be after the start time'));
  }
  if (this.passingMarks > this.maxMarks) return next(new Error('Passing marks cannot be more than maximum marks'));
  next();
});

// An examination session (for example "Midterm - Fall 2026") of one semester. Papers form the date sheet.
const examinationSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    type: { type: String, enum: EXAM_TYPES, required: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    papers: [paperSchema],
    status: { type: String, enum: Object.values(EXAM_STATUS), default: EXAM_STATUS.DRAFT, index: true },
    publishedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

examinationSchema.index({ 'papers.date': 1 });
examinationSchema.index({ semester: 1, name: 1 }, { unique: true });

examinationSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate < this.startDate) {
    return next(new Error('Examination end date cannot be before the start date'));
  }
  next();
});

// Examination days are not teaching days. When a session is created, moved or deleted, the topics the scheduler placed are recalculated.
const recalcAfterExam = (doc) =>
  import('../services/teachingCalendarService.js')
    .then((m) => m.recalcForExam(doc))
    .catch((e) => console.error('Schedule recalculation failed:', e.message));
examinationSchema.post('save', (doc) => { recalcAfterExam(doc); });
examinationSchema.post('deleteOne', { document: true, query: false }, (doc) => { recalcAfterExam(doc); });

export default mongoose.model('Examination', examinationSchema);
