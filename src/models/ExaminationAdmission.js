import mongoose from 'mongoose';
import { REVIEW_STATUS } from '../config/constants.js';

// A student's request to sit an examination. `checks` is the list of rules (attendance, fees, documents ...)
// as the server evaluated them, so the student can always see WHY the request is pending or rejected.
const examinationAdmissionSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    examination: { type: mongoose.Schema.Types.ObjectId, ref: 'Examination', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
    status: { type: String, enum: Object.values(REVIEW_STATUS), default: REVIEW_STATUS.PENDING, index: true },
    checks: [{ key: String, label: String, passed: Boolean, detail: String, _id: false }],
    reason: { type: String, default: '' }, // plain-language explanation shown to the student
    remarks: { type: String, trim: true, maxlength: 1000, default: '' }, // from the reviewer
    requestedAt: { type: Date, default: Date.now },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    // Set when the finance office applied at the counter for a student who cannot use the online system.
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    atOffice: { type: Boolean, default: false },
  },
  { timestamps: true }
);

examinationAdmissionSchema.index({ student: 1, examination: 1 }, { unique: true });

export default mongoose.model('ExaminationAdmission', examinationAdmissionSchema);
