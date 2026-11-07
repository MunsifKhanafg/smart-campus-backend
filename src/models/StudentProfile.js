import mongoose from 'mongoose';
import { STUDENT_STATUS } from '../config/constants.js';

// One StudentProfile per student User. The User holds login data; the profile holds academic identity.
const studentProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    rollNumber: { type: String, required: true, unique: true, trim: true, uppercase: true, maxlength: 30 },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    // Current semester. Changed only through the "assign semester" action so enrollments stay consistent.
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', default: null, index: true },
    section: { type: String, trim: true, uppercase: true, maxlength: 10, default: 'A' },
    admissionYear: { type: Number, min: 2000, max: 2100 },
    dateOfBirth: Date,
    guardianName: { type: String, trim: true, maxlength: 100, default: '' },
    guardianPhone: { type: String, trim: true, maxlength: 30, default: '' },
    address: { type: String, trim: true, maxlength: 300, default: '' },
    status: { type: String, enum: Object.values(STUDENT_STATUS), default: STUDENT_STATUS.ACTIVE, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

studentProfileSchema.index({ department: 1, semester: 1 });

export default mongoose.model('StudentProfile', studentProfileSchema);
