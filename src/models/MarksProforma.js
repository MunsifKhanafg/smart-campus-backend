import mongoose from 'mongoose';
import { MARKS_STATUS } from '../config/constants.js';

// Subject-wise marks proforma row: the 100 marks of ONE student in ONE course.
//   internal (40): assignment 5, quiz 5, attendance 5, presentation 5, midterm 20  -> entered by the course teacher
//   final term (60)                                                                  -> added by the teacher after the final paper
// null means "not entered yet". Totals, grade and pass/fail are NEVER stored: services/proformaService.js calculates them
// from these numbers and the university grading rules every time, so they can never disagree with the marks.
// AI never touches this collection.
const marksProformaSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    assignment: { type: Number, default: null, min: 0, max: 5 },
    quiz: { type: Number, default: null, min: 0, max: 5 },
    attendance: { type: Number, default: null, min: 0, max: 5 },
    presentation: { type: Number, default: null, min: 0, max: 5 },
    midterm: { type: Number, default: null, min: 0, max: 20 },
    finalTerm: { type: Number, default: null, min: 0, max: 60 },

    // draft = the teacher can still change it. submitted = sent to the Principal / Examination Department and locked (the HOD can unlock).
    status: { type: String, enum: Object.values(MARKS_STATUS), default: MARKS_STATUS.DRAFT },
    enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: Date,
  },
  { timestamps: true }
);

marksProformaSchema.index({ course: 1, student: 1 }, { unique: true });
marksProformaSchema.index({ semester: 1, department: 1 });

export default mongoose.model('MarksProforma', marksProformaSchema);
