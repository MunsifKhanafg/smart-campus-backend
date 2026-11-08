import mongoose from 'mongoose';

const gradeRuleSchema = new mongoose.Schema(
  {
    grade: { type: String, required: true, trim: true },
    minPercentage: { type: Number, required: true, min: 0, max: 100 },
    gpaPoints: { type: Number, required: true, min: 0, max: 4 },
  },
  { _id: false }
);

const universitySettingsSchema = new mongoose.Schema(
  {
    // Singleton guard: only one settings document may exist.
    key: { type: String, default: 'global', unique: true, immutable: true },

    universityName: { type: String, default: 'Smart Campus University', trim: true, maxlength: 150 },
    campusName: { type: String, default: 'Main Campus', trim: true, maxlength: 150 },
    logoUrl: { type: String, default: '' },
    address: { type: String, default: '', trim: true },
    contactNumber: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    website: { type: String, default: '', trim: true },
    officeHours: { type: String, default: 'Mon - Fri, 9:00 AM - 4:00 PM' },

    currentAcademicYear: { type: String, default: '2025-2026', trim: true },

    gradingRules: {
      type: [gradeRuleSchema],
      default: [
        { grade: 'A', minPercentage: 85, gpaPoints: 4.0 },
        { grade: 'B', minPercentage: 70, gpaPoints: 3.0 },
        { grade: 'C', minPercentage: 60, gpaPoints: 2.0 },
        { grade: 'D', minPercentage: 50, gpaPoints: 1.0 },
        { grade: 'F', minPercentage: 0, gpaPoints: 0 },
      ],
    },
    passingPercentage: { type: Number, default: 50, min: 0, max: 100 },

    feePolicy: {
      lateFeeEnabled: { type: Boolean, default: true },
      currency: { type: String, default: 'PKR' },
    },
    // Where students can send fees: any number of bank accounts, JazzCash and EasyPaisa numbers. The FINANCE OFFICER manages
    // this list (Finance Desk > Payment accounts). Logged-in users read it, it is NOT part of the public settings.
    paymentAccounts: {
      type: [
        {
          kind: { type: String, enum: ['bank', 'jazzcash', 'easypaisa'], required: true },
          providerName: { type: String, default: '', trim: true, maxlength: 80 }, // bank name, or JazzCash / EasyPaisa
          accountTitle: { type: String, default: '', trim: true, maxlength: 120 },
          accountNumber: { type: String, required: true, trim: true, maxlength: 40 }, // account number or mobile wallet number
          iban: { type: String, default: '', trim: true, maxlength: 40 },
          branch: { type: String, default: '', trim: true, maxlength: 120 },
          instructions: { type: String, default: '', trim: true, maxlength: 600 },
          active: { type: Boolean, default: true },
        },
      ],
      default: [],
    },
    admissionRules: {
      minAttendancePercentage: { type: Number, default: 75, min: 0, max: 100 },
      requireFeePayment: { type: Boolean, default: true },
      requireDocuments: { type: Boolean, default: true },
      // Percentage of past-due assignments a student must have submitted (0 = rule switched off).
      minAssignmentCompletionPercentage: { type: Number, default: 0, min: 0, max: 100 },
      requirePreviousSemesterPass: { type: Boolean, default: false },
    },
    attendanceRules: {
      allowApprovedLeaveAsPresent: { type: Boolean, default: true },
    },

    // New-student admission portal (public Apply page). The University Head controls it from Settings.
    admissionPortal: {
      open: { type: Boolean, default: false }, // master switch
      intakeName: { type: String, default: '', trim: true, maxlength: 60 }, // e.g. "Fall 2026"
      startDate: { type: Date, default: null }, // first day applications are accepted
      deadline: { type: Date, default: null }, // last day applications are accepted (the whole day counts)
      instructions: { type: String, default: '', trim: true, maxlength: 2000 },
      externalUrl: { type: String, default: '', trim: true, maxlength: 300 }, // if set, applicants are sent there instead
      requiredDocuments: { type: [String], default: [] }, // empty = the default list in applicationService
      // ---- Merit list and interviews ----
      // The merit list is never shown while applications are open. After the closing date it is published on meritListDate
      // (automatically, or by the University Head with the Publish button). Publishing ranks every applicant inside
      // their department, calls the top meritSeats of each department for an interview and sends them the message.
      meritListDate: { type: Date, default: null },
      meritSeats: { type: Number, default: 0, min: 0, max: 5000 }, // applicants called for interview in EACH department
      meritAutoPublish: { type: Boolean, default: true }, // publish by itself on meritListDate
      interview: {
        date: { type: Date, default: null },
        time: { type: String, default: '', trim: true, maxlength: 40 },
        venue: { type: String, default: '', trim: true, maxlength: 200 },
        instructions: { type: String, default: '', trim: true, maxlength: 1000 },
      },
      meritListPublished: { type: Boolean, default: false }, // set by the publish step only (not by hand)
      meritListPublishedAt: { type: Date, default: null },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Always returns the single settings document, creating defaults on first call.
universitySettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

export default mongoose.model('UniversitySettings', universitySettingsSchema);
