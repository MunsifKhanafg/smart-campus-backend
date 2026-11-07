import mongoose from 'mongoose';
import { QUIZ_TYPES, QUIZ_STATUS } from '../config/constants.js';

const questionSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true, maxlength: 1000 },
  options: {
    type: [{ type: String, trim: true, maxlength: 300 }],
    validate: [(v) => v.length >= 2 && v.length <= 6, 'A question needs 2 to 6 options'],
  },
  correctIndex: { type: Number, required: true, min: 0 }, // NEVER sent to students
  marks: { type: Number, default: 1, min: 0.5, max: 100 },
});

// A quiz is multiple choice so the server can mark it automatically.
//   scheduled: students may start between startTime and endTime.
//   surprise : hidden until the teacher presses "start". The window is startedAt .. startedAt + duration.
const quizSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    type: { type: String, enum: QUIZ_TYPES, required: true },
    status: { type: String, enum: Object.values(QUIZ_STATUS), default: QUIZ_STATUS.DRAFT, index: true },
    durationMinutes: { type: Number, required: true, min: 1, max: 240 },
    startTime: Date, // scheduled quizzes
    endTime: Date, // scheduled quizzes
    startedAt: Date, // surprise quizzes: when the teacher started it
    closedAt: Date,
    maxAttempts: { type: Number, default: 1, min: 1, max: 5 },
    questions: [questionSchema],
    maxMarks: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

quizSchema.pre('validate', function (next) {
  this.maxMarks = this.questions.reduce((sum, q) => sum + q.marks, 0);
  for (const q of this.questions) {
    if (q.correctIndex >= q.options.length) return next(new Error('Correct answer must point to one of the options'));
  }
  if (this.type === 'scheduled') {
    if (!this.startTime || !this.endTime) return next(new Error('Scheduled quizzes need a start and end time'));
    if (this.endTime <= this.startTime) return next(new Error('Quiz end time must be after the start time'));
  }
  next();
});

export default mongoose.model('Quiz', quizSchema);
