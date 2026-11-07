import Notification from '../models/Notification.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';

// Every user only ever reads and changes their own notifications.
export const listMyNotifications = asyncHandler(async (req, res) => {
  const filter = { recipient: req.user._id };
  if (req.query.unread === 'true') filter.isRead = false;
  const [items, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(100),
    Notification.countDocuments({ recipient: req.user._id, isRead: false }),
  ]);
  sendSuccess(res, { items, unreadCount });
});

export const markRead = asyncHandler(async (req, res) => {
  const n = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipient: req.user._id },
    { isRead: true, readAt: new Date() },
    { new: true }
  );
  if (!n) throw ApiError.notFound('Notification not found');
  sendSuccess(res, n);
});

export const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ recipient: req.user._id, isRead: false }, { isRead: true, readAt: new Date() });
  sendSuccess(res, null, 'All notifications marked as read');
});
