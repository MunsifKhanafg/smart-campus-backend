import mongoose from 'mongoose';
import connectDB from '../src/config/db.js';
import { sweepQuizzes } from '../src/services/quizService.js';
import { deliverDueAnnouncements } from '../src/services/announcementService.js';
import { autoPublishMerit } from '../src/services/meritService.js';
import { runFeeReminders } from '../src/services/feeReminderService.js';
import { runLibraryJobs } from '../src/services/libraryService.js';

// On your own computer src/server.js runs these jobs on timers. Vercel has no timers, so Vercel Cron calls this address
// once a day instead (see "crons" in vercel.json). Vercel sends  Authorization: Bearer <CRON_SECRET>  automatically
// when the CRON_SECRET environment variable exists, so nobody else can trigger it.
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  try {
    if (mongoose.connection.readyState !== 1) await connectDB();
    const jobs = { quizzes: sweepQuizzes, announcements: deliverDueAnnouncements, meritList: autoPublishMerit, feeReminders: runFeeReminders, library: () => runLibraryJobs({ force: true }) };
    const result = {};
    for (const [name, run] of Object.entries(jobs)) {
      try { result[name] = (await run()) ?? 'done'; } catch (err) { result[name] = `failed: ${err.message}`; }
    }
    res.status(200).json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}
