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
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: Date,
    lastLogin: Date,
  },
  { timestamps: true }
);

userSchema.pre('validate', function (next) {
  const needsDept = [ROLES.HOD, ROLES.TEACHER, ROLES.STUDENT].includes(this.role);
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
