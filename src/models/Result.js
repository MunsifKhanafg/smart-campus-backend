import mongoose from 'mongoose';
import { RESULT_STATUS } from '../config/constants.js';

// The calculated result of one student in one examination. Created ONLY by backend code (gradingService),
// from teacher-entered marks and the grading rules in UniversitySettings.
const subjectSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course' },
    code: String,
    title: String,
    maxMarks: Number,
    passingMarks: Number,
    obtained: Number,
    absent: Boolean,
    passed: Boolean,
  },
  { _id: false }
);

const resultSchema = new mongoose.Schema(
  {
    examination: { type: mongoose.Schema.Types.ObjectId, ref: 'Examination', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
    semesterNumber: { type: Number, required: true },
    subjects: [subjectSchema],
    totalMax: { type: Number, required: true },
    totalObtained: { type: Number, required: true },
    percentage: { type: Number, required: true },
    grade: { type: String, required: true },
    gpaPoints: { type: Number, default: 0 },
    outcome: { type: String, enum: ['pass', 'fail'], required: true },
    status: { type: String, enum: Object.values(RESULT_STATUS), default: RESULT_STATUS.DRAFT, index: true },
    publishedAt: Date,
    compiledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

resultSchema.index({ examination: 1, student: 1 }, { unique: true });

export default mongoose.model('Result', resultSchema);
