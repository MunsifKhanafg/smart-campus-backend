import mongoose from 'mongoose';
import { REVIEW_STATUS } from '../config/constants.js';
import { fileSchema } from './shared.js';

// A document uploaded by a student for examination admission (for example "challan", "transcript", "photo").
const studentDocumentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    type: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    files: { type: [fileSchema], validate: [(v) => v.length > 0, 'Attach at least one file'] },
    status: { type: String, enum: Object.values(REVIEW_STATUS), default: REVIEW_STATUS.PENDING, index: true },
    remarks: { type: String, trim: true, maxlength: 1000, default: '' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

export default mongoose.model('StudentDocument', studentDocumentSchema);
