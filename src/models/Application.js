import mongoose from 'mongoose';
import { fileSchema } from './shared.js';
import { APPLICATION_STATUS } from '../services/applicationService.js';

// One online application for admission as a new student. The applicant has no login: they follow it with
// the application number plus the email they applied with.
const historySchema = new mongoose.Schema(
  {
    status: { type: String, enum: Object.values(APPLICATION_STATUS), required: true },
    note: { type: String, default: '', maxlength: 1000 },
    by: { type: String, default: 'applicant' }, // 'applicant' or the staff member's name
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const documentSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 }, // which required document this file is
    file: { type: fileSchema, required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const applicationSchema = new mongoose.Schema(
  {
    applicationNumber: { type: String, required: true, unique: true, index: true },
    intake: { type: String, default: '', trim: true },
    status: { type: String, enum: Object.values(APPLICATION_STATUS), default: APPLICATION_STATUS.SUBMITTED, index: true },

    name: { type: String, required: true, trim: true, maxlength: 100 },
    fatherName: { type: String, required: true, trim: true, maxlength: 100 },
    gender: { type: String, enum: ['male', 'female', 'other'], required: true },
    dateOfBirth: { type: Date, required: true },
    nationalId: { type: String, required: true, trim: true, maxlength: 20 }, // CNIC or B-Form number
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    city: { type: String, default: '', trim: true, maxlength: 80 },

    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    program: { type: String, default: '', trim: true, maxlength: 150 }, // BS programme name chosen on the form
    secondDepartment: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },

    matricMarks: { type: Number, required: true, min: 0 },
    matricTotal: { type: Number, required: true, min: 1 },
    interMarks: { type: Number, required: true, min: 0 },
    interTotal: { type: Number, required: true, min: 1 },
    testMarks: { type: Number, min: 0, default: null },
    testTotal: { type: Number, min: 1, default: null },
    meritScore: { type: Number, default: 0, index: true }, // calculated by the server
    // Filled in when the merit list is published (never before). Rank is frozen at that moment.
    merit: {
      rank: { type: Number, default: null, index: true },
      called: { type: Boolean, default: false }, // called for an interview
      interviewDate: { type: Date, default: null },
      interviewTime: { type: String, default: '' },
      venue: { type: String, default: '' },
      message: { type: String, default: '' }, // the interview message the applicant sees on the tracking page
      notifiedAt: { type: Date, default: null },
      emailStatus: { type: String, enum: ['none', 'sent', 'failed'], default: 'none' },
    },

    documents: [documentSchema],
    remarks: { type: String, default: '', maxlength: 1000 }, // the latest message from staff, shown to the applicant
    history: [historySchema],

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    enrolledUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Written when the merit list is published (services/meritService.js): the frozen rank inside the department and,
    // for the top candidates, the interview call the applicant reads on the tracking page.
    merit: {
      rank: { type: Number, default: null },
      called: { type: Boolean, default: false },
      interviewDate: { type: Date, default: null },
      interviewTime: { type: String, default: '' },
      venue: { type: String, default: '' },
      message: { type: String, default: '' },
      notifiedAt: { type: Date, default: null },
      emailStatus: { type: String, enum: ['none', 'sent', 'failed'], default: 'none' },
    },
  },
  { timestamps: true }
);

applicationSchema.pre('validate', function (next) {
  if (this.matricMarks > this.matricTotal) return next(new Error('Matric marks cannot be more than the total'));
  if (this.interMarks > this.interTotal) return next(new Error('Intermediate marks cannot be more than the total'));
  if (this.testMarks != null && this.testTotal != null && this.testMarks > this.testTotal) return next(new Error('Test marks cannot be more than the total'));
  next();
});

applicationSchema.index({ department: 1, status: 1, meritScore: -1 });

export default mongoose.model('Application', applicationSchema);
