import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  getRules, updateRules, myToday, checkIn, checkOut, myMonth, overview, monthlySummary, markStaff, moveTopics,
  requestLeave, listLeaves, reviewLeave, cancelLeave,
} from '../controllers/staffAttendanceController.js';

const { UNIVERSITY_HEAD, HOD, TEACHER, FINANCE_OFFICER } = ROLES;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the format HH:MM (24 hours)');
const idParam = validate(z.object({ id: objectId }), 'params');

const rulesSchema = z.object({
  timezone: z.string().min(3).max(60).refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown time zone').optional(),
  opensAt: time.optional(),
  graceMinutes: z.number().int().min(0).max(240).optional(),
  absentAfter: time.optional(),
  closesAt: time.optional(),
  requireOnCampus: z.boolean().optional(),
  maxAccuracyMeters: z.number().int().min(10).max(2000).optional(),
  campus: z.object({
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    radiusMeters: z.number().int().min(20).max(5000).optional(),
  }).optional(),
});

const checkInSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracy: z.number().min(0).max(100000).optional(),
  note: z.string().trim().max(300).optional(),
});

const leaveSchema = z.object({
  fromDate: day,
  toDate: day,
  type: z.enum(['casual', 'sick', 'official', 'other']).default('casual'),
  reason: z.string().trim().min(3, 'Please write the reason').max(600),
}).refine((v) => v.toDate >= v.fromDate, { message: 'The last day cannot be before the first day', path: ['toDate'] });

const reviewSchema = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).optional() });
const markSchema = z.object({
  user: objectId,
  date: day,
  status: z.enum(['present', 'late', 'absent', 'leave']),
  note: z.string().trim().min(3, 'Write the reason for the correction').max(300),
});
const moveSchema = z.object({ date: day, user: objectId.optional() });
const monthQuery = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), date: day.optional(), department: objectId.optional(), scope: z.enum(['mine', 'review']).optional(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() });

export const staffAttendanceRouter = Router();
staffAttendanceRouter.use(protect);

// The college's rules: everyone who works here may read them, only the principal changes them.
staffAttendanceRouter.get('/rules', authorize(UNIVERSITY_HEAD, HOD, TEACHER, FINANCE_OFFICER), getRules);
staffAttendanceRouter.put('/rules', authorize(UNIVERSITY_HEAD), validate(rulesSchema), updateRules);

// A teacher's / HOD's / finance officer's own day.
staffAttendanceRouter.get('/today', authorize(HOD, TEACHER, FINANCE_OFFICER), myToday);
staffAttendanceRouter.post('/check-in', authorize(HOD, TEACHER, FINANCE_OFFICER), validate(checkInSchema), checkIn);
staffAttendanceRouter.post('/check-out', authorize(HOD, TEACHER, FINANCE_OFFICER), checkOut);
staffAttendanceRouter.get('/mine', authorize(HOD, TEACHER, FINANCE_OFFICER), validate(monthQuery, 'query'), myMonth);

// Leave requests. The finance officer's and the HODs' requests are decided by the principal; a teacher's by the HOD or the principal.
staffAttendanceRouter.get('/leaves', authorize(UNIVERSITY_HEAD, HOD, TEACHER, FINANCE_OFFICER), validate(monthQuery, 'query'), listLeaves);
staffAttendanceRouter.post('/leaves', authorize(HOD, TEACHER, FINANCE_OFFICER), validate(leaveSchema), requestLeave);
staffAttendanceRouter.patch('/leaves/:id/review', authorize(UNIVERSITY_HEAD, HOD), idParam, validate(reviewSchema), reviewLeave);
staffAttendanceRouter.delete('/leaves/:id', authorize(HOD, TEACHER, FINANCE_OFFICER), idParam, cancelLeave);

// The principal / the HOD: who is here today, the month, corrections.
staffAttendanceRouter.get('/overview', authorize(UNIVERSITY_HEAD, HOD), validate(monthQuery, 'query'), overview);
staffAttendanceRouter.get('/summary', authorize(UNIVERSITY_HEAD, HOD), validate(monthQuery, 'query'), monthlySummary);
staffAttendanceRouter.put('/mark', authorize(UNIVERSITY_HEAD, HOD), validate(markSchema), markStaff);

// Move the contents planned for a day to the next teaching day (own contents, or a teacher's for the HOD / principal).
staffAttendanceRouter.post('/move-topics', authorize(UNIVERSITY_HEAD, HOD, TEACHER), validate(moveSchema), moveTopics);
