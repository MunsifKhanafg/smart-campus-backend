import Notification from '../models/Notification.js';

// Sends the same in-app notification to many users. Like the audit log, a failure here must never break the real request.
export const notifyUsers = (userIds, { title, message = '', type = 'general', link = '' }) => {
  const unique = [...new Set(userIds.filter(Boolean).map(String))];
  if (!unique.length) return Promise.resolve();
  // Titles and messages built from user text (quiz or announcement titles) can exceed the model limits.
  // Without trimming, the whole batch would be rejected and nobody would be notified.
  const safeTitle = String(title).slice(0, 150);
  const safeMessage = String(message || '').slice(0, 1000);
  return Notification.insertMany(unique.map((recipient) => ({ recipient, title: safeTitle, message: safeMessage, type, link }))).catch((err) =>
    console.error('Notification failed:', err.message)
  );
};
