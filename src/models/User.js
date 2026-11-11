import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ROLE_LIST, ROLES } from '../config/constants.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email address'],
    },
    password: { type: String, required: true, minlength: 8, select: false },
    role: { type: String, enum: ROLE_LIST, required: true, index: true },
    // Required for HOD / teacher / student. Head and finance officer are university-wide.
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', index: true },
    phone: { type: String, trim: true },
    // Teachers and HODs: highest degree or specialisation, shown to the principal and the HOD when subjects are assigned.
    qualification: { type: String, trim: true, maxlength: 200, default: '' },
    // Subjects this teacher can teach (free text, for example "English", "Mathematics", "Data Structures"). When a teacher is chosen for
    // a subject, the list shows the teachers whose subjects fit it.
    subjects: { type: [String], default: [] },
    // Other departments this teacher also teaches in (common subjects such as English or Islamiat are taught everywhere).
    // The HOD of such a department can give this teacher classes, without a second account.
    extraDepartments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }],
    // Common-subject teacher (English, Mathematics, Islamiat...): may be given classes by the HOD of EVERY department.
    allDepartments: { type: Boolean, default: false },
    // Weekly teaching hours the administrator allows for this teacher. Empty = no limit has been set.
    maxWeeklyHours: { type: Number, min: 1, max: 60, default: null },
    // Professional and personal details of a teacher, HOD, principal or finance officer: education and degrees, experience, designation.
    // Not sent with the normal user lists (select: false). The profile route asks for it and decides who may read which part.
    profile: {
      type: new mongoose.Schema(
        {
          designation: { type: String, trim: true, maxlength: 100, default: '' }, // Lecturer, Assistant Professor, Principal ...
          gender: { type: String, enum: ['', 'male', 'female', 'other'], default: '' },
          dateOfBirth: Date,
          joiningDate: Date,
          address: { type: String, trim: true, maxlength: 250, default: '' },
          city: { type: String, trim: true, maxlength: 60, default: '' },
          experienceYears: { type: Number, min: 0, max: 60, default: null },
          bio: { type: String, trim: true, maxlength: 1500, default: '' },
          education: [
            {
              level: { type: String, enum: ['matric', 'intermediate', 'bachelors', 'masters', 'mphil', 'phd', 'postdoc', 'diploma', 'other'], required: true },
              degree: { type: String, required: true, trim: true, maxlength: 120 },
              field: { type: String, trim: true, maxlength: 120, default: '' },
              institution: { type: String, required: true, trim: true, maxlength: 150 },
              year: Number,
              grade: { type: String, trim: true, maxlength: 40, default: '' },
              _id: false,
            },
          ],
          experience: [
            {
              title: { type: String, required: true, trim: true, maxlength: 120 },
              organization: { type: String, required: true, trim: true, maxlength: 150 },
              fromYear: Number,
              toYear: Number,
              details: { type: String, trim: true, maxlength: 500, default: '' },
              _id: false,
            },
          ],
        },
        { _id: false }
      ),
      select: false,
    },
    // The photo itself is in the UserPhoto collection. These two fields only say that one exists and when it changed (for caching).
    hasPhoto: { type: Boolean, default: false },
    photoUpdatedAt: Date,
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: Date,
    lastLogin: Date,
  },
  { timestamps: true }
);

userSchema.pre('validate', function (next) {
  // A common-subject teacher (English, Mathematics, Islamiat...) teaches in every department, so they need no home department.
  const needsDept = [ROLES.HOD, ROLES.STUDENT].includes(this.role) || (this.role === ROLES.TEACHER && !this.allDepartments);
  if (needsDept && !this.department) {
    return next(new Error(`Department is required for role "${this.role}"`));
  }
  next();
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);
  next();
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.changedPasswordAfter = function (jwtIssuedAt) {
  if (!this.passwordChangedAt) return false;
  return Math.floor(this.passwordChangedAt.getTime() / 1000) > jwtIssuedAt;
};

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

export default mongoose.model('User', userSchema);
