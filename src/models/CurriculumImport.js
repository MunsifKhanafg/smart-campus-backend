import mongoose from 'mongoose';

// An uploaded curriculum file and what the system extracted from it.
// The extraction is only a DRAFT: nothing reaches the Program catalogue until the administrator reviews, edits and approves it.
const subjectSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, uppercase: true, maxlength: 20 },
    title: { type: String, trim: true, maxlength: 150 },
    creditHours: { type: Number, min: 1, max: 6, default: 3 },
    outline: { type: String, trim: true, maxlength: 5000, default: '' },
  },
  { _id: false }
);

const importSchema = new mongoose.Schema(
  {
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    file: { originalName: String, storedName: String, mimeType: String, size: Number },
    status: { type: String, enum: ['review', 'approved', 'discarded'], default: 'review', index: true },
    method: { type: String, enum: ['ai', 'rules'], required: true }, // how the draft was produced
    warnings: [String],
    textLength: Number,
    programs: [
      {
        name: { type: String, trim: true, maxlength: 150 },
        department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null }, // chosen in review
        semesters: [{ number: { type: Number, min: 1, max: 12 }, subjects: [subjectSchema], _id: false }],
        _id: false,
      },
    ],
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
  },
  { timestamps: true }
);

export default mongoose.model('CurriculumImport', importSchema);
