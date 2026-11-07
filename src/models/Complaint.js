import mongoose from 'mongoose';
import { COMPLAINT_CATEGORIES, COMPLAINT_RECIPIENTS, COMPLAINT_STATUS } from '../config/constants.js';
import { fileSchema } from './shared.js';

// A complaint or request from a student. It is visible ONLY to that student and to the office it was sent to.
// Teachers cannot read complaints (even complaints about themselves), and a complaint never changes any record by itself.
const complaintSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    category: { type: String, enum: COMPLAINT_CATEGORIES, required: true },
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
  },
  { timestamps: true }
);

export default mongoose.model('Complaint', complaintSchema);
