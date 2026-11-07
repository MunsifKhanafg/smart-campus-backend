import mongoose from 'mongoose';

// One BS (or other) degree programme of ONE department, with its subjects organised semester by semester.
// It is the approved "catalogue" the HOD picks subjects from when assigning teachers.
// Programmes are created only when an administrator approves a curriculum import (see CurriculumImport).
const subjectSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    creditHours: { type: Number, required: true, min: 1, max: 6, default: 3 },
    // Course contents (topics covered). Copied into the class when it is created, so the teacher receives it on assignment.
    outline: { type: String, trim: true, maxlength: 5000, default: '' },
  },
  { _id: false }
);

const programSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 }, // e.g. "BS Computer Science"
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semesters: [
      {
        number: { type: Number, required: true, min: 1, max: 12 },
        subjects: [subjectSchema],
        _id: false,
      },
    ],
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    sourceImport: { type: mongoose.Schema.Types.ObjectId, ref: 'CurriculumImport' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

programSchema.index({ department: 1, name: 1 }, { unique: true });

export default mongoose.model('Program', programSchema);
