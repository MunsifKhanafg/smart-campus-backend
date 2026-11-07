import mongoose from 'mongoose';
import { ASSIGNMENT_TYPES } from '../config/constants.js';
import { fileSchema } from './shared.js';

const assignmentSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
    type: { type: String, enum: ASSIGNMENT_TYPES, default: 'assignment' },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    instructions: { type: String, trim: true, maxlength: 5000, default: '' },
    releaseDate: { type: Date, required: true },
    deadline: { type: Date, required: true },
    maxMarks: { type: Number, required: true, min: 1, max: 1000 },
    allowLateSubmission: { type: Boolean, default: false },
    attachments: [fileSchema], // instruction documents from the teacher
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

assignmentSchema.pre('validate', function (next) {
  if (this.releaseDate && this.deadline && this.deadline <= this.releaseDate) {
    return next(new Error('Deadline must be after the release date'));
  }
  next();
});

export default mongoose.model('Assignment', assignmentSchema);
