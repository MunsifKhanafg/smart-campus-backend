import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import mongoose from 'mongoose';
import { dbStatus, dbConnected } from './config/db.js';
import { authRouter, settingsRouter, departmentRouter, userRouter } from './routes/index.js';
import { semesterRouter, courseRouter, curriculumRouter, teachingRouter } from './routes/academic.js';
import { studentRouter, enrollmentRouter, timetableRouter, calendarRouter, notificationRouter } from './routes/phase3.js';
import { topicRouter, assignmentRouter, attendanceRouter, quizRouter } from './routes/phase4.js';
import { examinationRouter, marksRouter, resultRouter, publicResultRouter } from './routes/phase5.js';
import { feeRouter, paymentRouter, documentRouter, admissionRouter } from './routes/phase6.js';
import { complaintRouter, announcementRouter, publicContactRouter, reportRouter, aiRouter } from './routes/phase7.js';
import { publicAdmissionRouter, applicationRouter } from './routes/applications.js';
import { stripeWebhook } from './controllers/paymentController.js';
import { teachingCalendarRouter } from './routes/teachingCalendar.js';
import { profileRouter, photoRouter } from './routes/profile.js';
import { staffAttendanceRouter } from './routes/staffAttendance.js';
import { supportStaffRouter } from './routes/supportStaff.js';
import { studentLeaveRouter } from './routes/studentLeave.js';
import { libraryRouter } from './routes/library.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { BRANDING_DIR } from './middleware/upload.js';

const app = express();

app.set('trust proxy', 1);
// Logos are loaded by the React app on another origin, so allow cross-origin image loading.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
// Allowed browser origins: CLIENT_URL (comma separated). In development any localhost port is also accepted,
// because Vite moves to 5174, 5175... when 5173 is busy and the browser would then block every request.
// A trailing "/" is a common typo in CLIENT_URL (https://site.vercel.app/ never matches the browser's https://site.vercel.app), so it is removed.
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const localDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(
  cors({
    origin: (origin, cb) => {
      const ok = !origin || allowedOrigins.includes(origin) || (process.env.NODE_ENV !== 'production' && localDev.test(origin));
      // Without this line a blocked website is silent: the browser only says "Network Error". Vercel > Logs now names the address to add.
      if (!ok) console.warn(`CORS: blocked the website ${origin}. Add it to CLIENT_URL (now: ${allowedOrigins.join(', ')})`);
      cb(null, ok);
    },
    credentials: true,
    // The browser may only read these response headers: the renewed login token and the download file name.
    exposedHeaders: ['X-Renewed-Token', 'Content-Disposition'],
  })
);

// The payment gateway's webhook must be read as RAW bytes (its signature is computed over them),
// so it is registered BEFORE express.json(). It is authenticated by the signature, not by a login.
app.post('/api/payments/webhook/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);

app.use(express.json({ limit: '1mb' }));
app.use(mongoSanitize()); // blocks NoSQL injection like { "$gt": "" }
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Only public branding files are served statically. Everything else (materials, submissions, documents, complaints)
// lives in uploads/private and is reachable only through protected download routes.
app.use('/uploads/branding', express.static(BRANDING_DIR, { maxAge: '1d' }));

// The bare address of the server has no page. Say so clearly instead of a confusing "Route not found".
app.get('/', (_req, res) => res.json({ success: true, message: 'Smart Campus API is running. The website is a separate project. Check /api/health for the database status.' }));

app.get('/api/health', (_req, res) =>
  res.json({ success: true, message: 'Smart Campus API running', startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), database: dbConnected() ? 'connected' : 'disconnected', problem: dbStatus.lastError || undefined })
);

// While MongoDB is unreachable every other API call gets a readable 503 (the login page shows this message).
app.use('/api', (_req, res, next) => {
  if (mongoose.connection.readyState === 1) return next();
  res.status(503).json({
    success: false,
    message: `The database is not connected. ${dbStatus.lastError || 'Please wait a few seconds and try again.'}`,
  });
});

app.use('/api', apiLimiter);
app.use('/api/auth', authRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/departments', departmentRouter);
app.use('/api/users', userRouter);
app.use('/api/profile', profileRouter); // education / degrees / experience and the photo of every person
app.use('/api/photos', photoRouter);
app.use('/api/support-staff', supportStaffRouter); // Class IV staff and their daily duties (principal and HODs only)
app.use('/api/student-leaves', studentLeaveRouter); // student leave: student asks, HOD decides, principal views
app.use('/api/library', libraryRouter); // books, desk, reservations, fines, reports. Library controller runs it, the principal monitors, students see their own
app.use('/api/staff-attendance', staffAttendanceRouter); // teachers' own attendance: check-in, late, auto-absent, leave, proof of presence
app.use('/api/semesters', semesterRouter);
app.use('/api/courses', courseRouter);
app.use('/api/curriculum', curriculumRouter);
app.use('/api/teaching', teachingRouter);

// Phase 3
app.use('/api/students', studentRouter);
app.use('/api/enrollments', enrollmentRouter);
app.use('/api/timetables', timetableRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/notifications', notificationRouter);

// Phase 4
app.use('/api/topics', topicRouter);
app.use('/api/teaching-calendar', teachingCalendarRouter); // teaching days + automatic content scheduling
app.use('/api/assignments', assignmentRouter);
app.use('/api/attendance', attendanceRouter);
app.use('/api/quizzes', quizRouter);

// Phase 5
app.use('/api/examinations', examinationRouter);
app.use('/api/marks', marksRouter);
app.use('/api/results', resultRouter);

// Phase 6
app.use('/api/fees', feeRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/documents', documentRouter);
app.use('/api/admissions', admissionRouter);

// Phase 7 and 8
app.use('/api/complaints', complaintRouter);
app.use('/api/announcements', announcementRouter);
app.use('/api/reports', reportRouter);
app.use('/api/ai', aiRouter);
app.use('/api/applications', applicationRouter); // new-student applications: staff review and merit list

// Public (no login)
app.use('/api/public', publicContactRouter);
app.use('/api/public', publicResultRouter);
app.use('/api/public', publicAdmissionRouter); // admission portal: apply, track, merit list

app.use(notFound);
app.use(errorHandler);

export default app;
