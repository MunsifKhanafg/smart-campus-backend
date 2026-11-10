import mongoose from 'mongoose';
import { COURSE_STATUS } from '../config/constants.js';

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 150 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    // department is stored on the course too, so department isolation is a single indexed filter.
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    creditHours: { type: Number, required: true, min: 1, max: 6 },
    // How many classes per week this subject is taught. Empty = as many as its credit hours (3 credit hours = 3 classes).
    // Colleges that teach more (or fewer) classes per week than the credit hours set it here, and the timetable follows it.
    weeklyClasses: { type: Number, min: 1, max: 20, default: null },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    outline: { type: String, trim: true, maxlength: 10000, default: '' },
    section: { type: String, trim: true, uppercase: true, maxlength: 10, default: 'A' },
    // Set when the course was created from an approved BS curriculum (see Program).
    program: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', default: null },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    startDate: Date,
    endDate: Date,
    status: { type: String, enum: Object.values(COURSE_STATUS), default: COURSE_STATUS.ACTIVE, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// The same course code may exist in different sections, but never twice in one section of a semester.
courseSchema.index({ semester: 1, code: 1, section: 1 }, { unique: true });

courseSchema.pre('validate', function (next) {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    return next(new Error('Course end date must be after the start date'));
  }
  next();
});

export default mongoose.model('Course', courseSchema);
