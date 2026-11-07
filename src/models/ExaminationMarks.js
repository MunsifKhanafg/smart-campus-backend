import mongoose from 'mongoose';
import { MARKS_STATUS } from '../config/constants.js';

// Marks of one student in one paper. Entered by the course teacher; AI never touches this collection.
const examinationMarksSchema = new mongoose.Schema(
  {
    examination: { type: mongoose.Schema.Types.ObjectId, ref: 'Examination', required: true, index: true },
    paper: { type: mongoose.Schema.Types.ObjectId, required: true }, // _id of the paper inside the examination
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    marks: { type: Number, default: null, min: 0 }, // null when absent
    absent: { type: Boolean, default: false },
    status: { type: String, enum: Object.values(MARKS_STATUS), default: MARKS_STATUS.DRAFT },
    enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: Date,
  },
  { timestamps: true }
);

examinationMarksSchema.index({ examination: 1, course: 1, student: 1 }, { unique: true });

export default mongoose.model('ExaminationMarks', examinationMarksSchema);
