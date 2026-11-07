import mongoose from 'mongoose';
import { fileSchema } from './shared.js';

const submissionSchema = new mongoose.Schema(
  {
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, trim: true, maxlength: 10000, default: '' },
    files: [fileSchema],
    submittedAt: { type: Date, default: Date.now },
    isLate: { type: Boolean, default: false },
    marks: { type: Number, default: null, min: 0 },
    feedback: { type: String, trim: true, maxlength: 3000, default: '' },
    gradedAt: Date,
    gradedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One submission per student per assignment (re-submitting before grading replaces the files).
submissionSchema.index({ assignment: 1, student: 1 }, { unique: true });

export default mongoose.model('Submission', submissionSchema);
