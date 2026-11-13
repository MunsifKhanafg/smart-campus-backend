import mongoose from 'mongoose';
import { COMPLAINT_CATEGORIES, COMPLAINT_RECIPIENTS, COMPLAINT_STATUS, LIBRARY_COMPLAINT_CATEGORIES } from '../config/constants.js';
import { fileSchema } from './shared.js';

// A complaint or request from a student. It is visible ONLY to that student and to the office it was sent to.
// Teachers cannot read complaints (even complaints about themselves), and a complaint never changes any record by itself.
const complaintSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    // The library adds its own two categories (see LIBRARY_COMPLAINT_CATEGORIES). Students still only send COMPLAINT_CATEGORIES.
    category: { type: String, enum: [...COMPLAINT_CATEGORIES, ...LIBRARY_COMPLAINT_CATEGORIES], required: true },
    recipient: { type: String, enum: COMPLAINT_RECIPIENTS, required: true, index: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    relatedCourse: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null },
    attachments: [fileSchema],
    status: { type: String, enum: Object.values(COMPLAINT_STATUS), default: COMPLAINT_STATUS.OPEN, index: true },
    // The full history: every reply and status change, in order.
    responses: [
      {
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byRole: String,
        message: { type: String, maxlength: 3000 },
        status: String,
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    resolution: { type: String, trim: true, maxlength: 3000, default: '' },
    resolvedAt: Date,
    // 'student' = written by the student (always, before the library module existed). 'library' = filed automatically by the library
    // about a book the student did not return; `libraryLoan` says which loan, and the complaint closes by itself when the book comes back.
    source: { type: String, enum: ['student', 'library'], default: 'student', index: true },
    libraryLoan: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryLoan', default: null, index: true },
  },
  { timestamps: true }
);

export default mongoose.model('Complaint', complaintSchema);
