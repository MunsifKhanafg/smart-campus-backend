import { z } from 'zod';
import { objectId } from './validate.js';
import { DUTY_STATUS } from '../models/SupportDuty.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const optionalText = (max) => z.string().trim().max(max).optional();

// repeatUntil: the same duty is created for every day from `date` to `repeatUntil` (at most 31 days).
export const createDutySchema = z
  .object({
    staff: objectId,
    date: day,
    repeatUntil: day.optional(),
    title: z.string().trim().min(2, 'Write the duty').max(120),
    details: optionalText(500),
  })
  .refine((v) => !v.repeatUntil || v.repeatUntil >= v.date, { message: 'The last day cannot be before the first day', path: ['repeatUntil'] });

export const updateDutySchema = z
  .object({
    date: day,
    title: z.string().trim().min(2).max(120),
    details: optionalText(500),
    status: z.enum(DUTY_STATUS),
    note: optionalText(300),
  })
  .partial();

export const listDutiesQuery = z.object({
  department: objectId.optional(),
  staff: objectId.optional(),
  status: z.enum(DUTY_STATUS).optional(),
  date: day.optional(),
  from: day.optional(),
  to: day.optional(),
});
