import mongoose from 'mongoose';
import { APPLICATION_STATUS } from '../config/constants.js';

// A document the applicant uploaded (CNIC, certificate, photo ...). The file itself lives in uploads/private/applications.
const documentSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 80, default: 'Document' },
    originalName: { type: String, required: true },
    storedName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
  },
  { _id: false }
);

// One application of a NEW student through the public admission portal.
// It is not a student yet: no login and no student profile exist until the university creates them.
const applicationSchema = new mongoose.Schema(
  {
    applicationNumber: { type: String, required: true, unique: true }, // e.g. APP-2026-00017, shown to the applicant
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    program: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', default: null },
    programName: { type: String, trim: true, default: '' }, // copied, so the record stays readable if a programme is archived
    intake: { type: String, trim: true, default: '' }, // e.g. "Fall 2026", copied from the portal settings at the time

    applicant: {
      fullName: { type: String, required: true, trim: true, maxlength: 100 },
      fatherName: { type: String, required: true, trim: true, maxlength: 100 },
      gender: { type: String, enum: ['male', 'female', 'other'], required: true },
      dateOfBirth: { type: Date, required: true },
      cnic: { type: String, trim: true, default: '' },
      email: { type: String, required: true, trim: true, lowercase: true },
      phone: { type: String, required: true, trim: true },
      address: { type: String, required: true, trim: true, maxlength: 250 },
      city: { type: String, required: true, trim: true, maxlength: 60 },
    },
    education: {
      lastQualification: { type: String, enum: ['matric', 'intermediate', 'a_level', 'other'], required: true },
      institution: { type: String, required: true, trim: true, maxlength: 150 },
      board: { type: String, trim: true, maxlength: 100, default: '' },
      passingYear: { type: Number, required: true },
      obtainedMarks: { type: Number, required: true, min: 0 },
      totalMarks: { type: Number, required: true, min: 1 },
      percentage: { type: Number, min: 0, max: 100 }, // always calculated by the server, never taken from the form
    },
    statement: { type: String, trim: true, maxlength: 1500, default: '' },
    documents: [documentSchema],

    status: { type: String, enum: Object.values(APPLICATION_STATUS), default: APPLICATION_STATUS.SUBMITTED, index: true },
    review: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      remarks: { type: String, trim: true, maxlength: 1000, default: '' },
    },
    history: [
      {
        status: String,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        remarks: { type: String, default: '' },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

// The same person cannot apply twice to the same department in the same intake.
applicationSchema.index({ 'applicant.email': 1, department: 1, intake: 1 }, { unique: true });
applicationSchema.index({ department: 1, status: 1, createdAt: -1 });

export default mongoose.model('AdmissionApplication', applicationSchema);
