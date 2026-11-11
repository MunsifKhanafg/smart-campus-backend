import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES, DAYS } from '../config/constants.js';
import { courseCalendar, setTeachingDays, autoSchedule, regenerateSchedule } from '../controllers/teachingCalendarController.js';

const { UNIVERSITY_HEAD, HOD, TEACHER, STUDENT } = ROLES;
const courseParam = validate(z.object({ courseId: objectId }), 'params');

// Teaching days and automatic content scheduling of a class.
export const teachingCalendarRouter = Router();
teachingCalendarRouter.use(protect);
teachingCalendarRouter.get('/course/:courseId', authorize(UNIVERSITY_HEAD, HOD, TEACHER, STUDENT), courseParam, courseCalendar);
teachingCalendarRouter.put('/course/:courseId/days', authorize(TEACHER), courseParam, validate(z.object({ days: z.array(z.enum(DAYS)).max(7) })), setTeachingDays);
teachingCalendarRouter.post(
  '/course/:courseId/schedule',
  authorize(TEACHER),
  courseParam,
  validate(z.object({ titles: z.array(z.string().trim().min(2).max(200)).max(80).optional() })),
  autoSchedule
);
// "Regenerate Schedule": a new arrangement of every topic that is still ahead (taught and hand-dated topics stay).
teachingCalendarRouter.post('/course/:courseId/regenerate', authorize(TEACHER), courseParam, regenerateSchedule);
