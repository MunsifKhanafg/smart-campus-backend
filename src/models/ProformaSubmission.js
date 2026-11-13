import mongoose from 'mongoose';

// One "send to the Principal / Examination Department" of a subject's marks proforma. The whole sheet is stored as a snapshot,
// so what the office received never changes afterwards, even if the teacher corrects marks later (that creates a NEW version).
const proformaSubmissionSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // 'principal' = the University Head. 'examination' = the Examination Department, which in this system is run by the HOD of the department.
    recipients: { type: [{ type: String, enum: ['principal', 'examination'] }], validate: [(v) => v.length > 0, 'Choose at least one recipient'] },
    note: { type: String, trim: true, maxlength: 1000, default: '' },
    version: { type: Number, default: 1 },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} }, // students, passed, failed, average ... (for the list page)
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true }, // the complete sheet as it was sent
    receivedBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        as: { type: String, enum: ['principal', 'examination'] },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

proformaSubmissionSchema.index({ semester: 1, department: 1, createdAt: -1 });

export default mongoose.model('ProformaSubmission', proformaSubmissionSchema);
