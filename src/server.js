import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB, { dbStatus, dbConnected, explainDbError } from './config/db.js';
import app from './app.js';
import { sweepQuizzes } from './services/quizService.js';
import { deliverDueAnnouncements } from './services/announcementService.js';
import { autoPublishMerit } from './services/meritService.js';
import { checkEnv } from './config/validateEnv.js';

// Refuse to start with an unsafe configuration (see config/validateEnv.js and docs/SECURITY_REVIEW.md).
const { errors, warnings } = checkEnv();
warnings.forEach((w) => console.warn(`WARNING: ${w}`));
if (errors.length) {
  errors.forEach((e) => console.error(`CONFIG ERROR: ${e}`));
  process.exit(1);
}

const PORT = process.env.PORT || 5000;

// The HTTP server starts FIRST and the database connects in the background. If MongoDB cannot be reached the API
// stays up and answers every request with a clear "database not connected" message (see app.js) instead of the
// browser only seeing "Network Error". The connection is retried until it works.
const server = app.listen(PORT, () => console.log(`Smart Campus API on http://localhost:${PORT}`));
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Close the other server or change PORT in server/.env.` : `Server error: ${err.message}`);
  process.exit(1);
});

const connectWithRetry = async () => {
  console.log('Connecting to MongoDB...');
  try {
    await connectDB();
  } catch (err) {
    dbStatus.lastError = explainDbError(err);
    console.error(`MongoDB connection failed: ${dbStatus.lastError}\nRetrying in 10 seconds...`);
    setTimeout(connectWithRetry, 10 * 1000);
  }
};
connectWithRetry();

// Once a minute: finish quizzes whose time ran out and deliver announcements scheduled for now.
const job = setInterval(() => {
  if (!dbConnected()) return;
  sweepQuizzes().catch((e) => console.error('Quiz sweep failed:', e.message));
  deliverDueAnnouncements().catch((e) => console.error('Announcement job failed:', e.message));
  autoPublishMerit().catch((e) => console.error('Merit list job failed:', e.message)); // publishes on the merit list date
}, 60 * 1000);

const shutdown = () => {
  clearInterval(job);
  server.close(() => mongoose.connection.close().then(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
