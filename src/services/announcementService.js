import User from '../models/User.js';
import Announcement from '../models/Announcement.js';
import { notifyUsers } from '../utils/notify.js';

// Works out which users an announcement is for.
export const resolveAudience = async (a) => {
  const filter = { isActive: true };
  if (a.scope === 'departments') filter.department = { $in: a.departments };
  if (a.scope === 'users') filter._id = { $in: a.recipients };
  if (a.roles?.length) filter.role = { $in: a.roles };
  return User.find(filter).distinct('_id');
};

// Sends the in-app notifications once. The atomic "delivered" flag makes sure it can never happen twice.
export const deliverAnnouncement = async (announcement) => {
  const claimed = await Announcement.findOneAndUpdate({ _id: announcement._id, delivered: false }, { delivered: true, deliveredAt: new Date() }, { new: true });
  if (!claimed) return 0;
  const ids = await resolveAudience(claimed);
  const meeting = claimed.meeting?.date ? ` Meeting: ${claimed.meeting.date.toDateString()} ${claimed.meeting.time || ''} ${claimed.meeting.location || ''}`.trimEnd() : '';
  await notifyUsers(ids, { title: claimed.title, message: `${claimed.message.slice(0, 200)}${meeting}`, type: 'announcement', link: '/announcements' });
  return ids.length;
};

// Background job: announcements with a future publish date are delivered when that time arrives.
export const deliverDueAnnouncements = async () => {
  const due = await Announcement.find({ delivered: false, publishDate: { $lte: new Date() } });
  for (const a of due) await deliverAnnouncement(a);
};
