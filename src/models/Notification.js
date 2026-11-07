import mongoose from 'mongoose';

// Minimal in-app notification. Phase 7 builds the full notification centre on top of this model.
const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    message: { type: String, trim: true, maxlength: 1000, default: '' },
    type: { type: String, trim: true, default: 'general' }, // e.g. "timetable", "announcement"
    link: { type: String, trim: true, default: '' }, // front-end route to open
    isRead: { type: Boolean, default: false },
    readAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
