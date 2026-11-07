import mongoose from 'mongoose';
import { ENROLLMENT_STATUS } from '../config/constants.js';

// Links a student to a course. Dropping an enrollment keeps the row (status = dropped) so history is never lost.
const courseEnrollmentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    // Copied from the course so semester / department filters need no join.
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    status: { type: String, enum: Object.values(ENROLLMENT_STATUS), default: ENROLLMENT_STATUS.ENROLLED, index: true },
    enrolledAt: { type: Date, default: Date.now },
    droppedAt: Date,
    enrolledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    droppedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// A student can be linked to a course only once (re-enrolling reuses the same row).
courseEnrollmentSchema.index({ student: 1, course: 1 }, { unique: true });

export default mongoose.model('CourseEnrollment', courseEnrollmentSchema);
