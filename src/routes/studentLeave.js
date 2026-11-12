import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import { requestLeave, cancelLeave, listLeaves, reviewLeave } from '../controllers/studentLeaveController.js';

const { UNIVERSITY_HEAD, HOD, STUDENT } = ROLES;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const idParam = validate(z.object({ id: objectId }), 'params');

const leaveSchema = z
  .object({
    fromDate: day,
    toDate: day,
    type: z.enum(['sick', 'family', 'other']).default('sick'),
    reason: z.string().trim().min(3, 'Please write the reason').max(600),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: 'The last day cannot be before the first day', path: ['toDate'] });
const reviewSchema = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().trim().max(300).optional() });
const listQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), department: objectId.optional() });

// Mounted on /api/student-leaves
// student: asks and cancels · HOD: sees and decides the requests of their department · principal: sees everything (read only)
export const studentLeaveRouter = Router();
studentLeaveRouter.use(protect);
studentLeaveRouter.get('/', authorize(STUDENT, HOD, UNIVERSITY_HEAD), validate(listQuery, 'query'), listLeaves);
studentLeaveRouter.post('/', authorize(STUDENT), validate(leaveSchema), requestLeave);
studentLeaveRouter.patch('/:id/review', authorize(HOD), idParam, validate(reviewSchema), reviewLeave);
studentLeaveRouter.delete('/:id', authorize(STUDENT), idParam, cancelLeave);
