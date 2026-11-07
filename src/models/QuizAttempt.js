import mongoose from 'mongoose';
import { ATTEMPT_STATUS } from '../config/constants.js';

const quizAttemptSchema = new mongoose.Schema(
  {
    quiz: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    attemptNumber: { type: Number, required: true },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true }, // the server's deadline; the browser timer is only a display
    submittedAt: Date,
    answers: [{ question: { type: mongoose.Schema.Types.ObjectId, required: true }, selected: { type: Number, required: true }, _id: false }],
    status: { type: String, enum: Object.values(ATTEMPT_STATUS), default: ATTEMPT_STATUS.IN_PROGRESS, index: true },
    score: { type: Number, default: null },
    maxScore: { type: Number, default: null },
  },
  { timestamps: true }
);

quizAttemptSchema.index({ quiz: 1, student: 1, attemptNumber: 1 }, { unique: true });

export default mongoose.model('QuizAttempt', quizAttemptSchema);
