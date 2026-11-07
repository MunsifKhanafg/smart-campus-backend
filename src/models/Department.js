import mongoose from 'mongoose';
import { DEPARTMENT_STATUS } from '../config/constants.js';

const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150, unique: true },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 12, unique: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    hod: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: {
      type: String,
      enum: Object.values(DEPARTMENT_STATUS),
      default: DEPARTMENT_STATUS.ACTIVE,
      index: true,
    },
    contact: {
      email: { type: String, trim: true, lowercase: true, default: '' },
      phone: { type: String, trim: true, default: '' },
      office: { type: String, trim: true, default: '' },
      officeHours: { type: String, trim: true, default: '' },
    },
    // Keeps a trail of who led the department, so a transfer never loses history.
    hodHistory: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        from: Date,
        to: Date,
        _id: false,
      },
    ],
    archivedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('Department', departmentSchema);
