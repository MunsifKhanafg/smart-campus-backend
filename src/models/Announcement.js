import mongoose from 'mongoose';
import { ROLE_LIST } from '../config/constants.js';

// Announcements and meeting notices. `scope` decides who receives it:
//   all          -> every active user
//   departments  -> users of the listed departments
//   users        -> only the listed users
// `roles` (optional) narrows it further, for example "teachers of CS only".
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    publishDate: { type: Date, default: Date.now, index: true },
    scope: { type: String, enum: ['all', 'departments', 'users'], required: true },
    departments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Department' }],
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    roles: [{ type: String, enum: ROLE_LIST }],
    meeting: {
      date: Date,
      time: { type: String, trim: true, maxlength: 20 },
      location: { type: String, trim: true, maxlength: 200 },
    },
    isPublic: { type: Boolean, default: false }, // also shown on the public contact page (head only)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdByRole: String,
    delivered: { type: Boolean, default: false, index: true }, // notifications already sent?
    deliveredAt: Date,
  },
  { timestamps: true }
);

export default mongoose.model('Announcement', announcementSchema);
