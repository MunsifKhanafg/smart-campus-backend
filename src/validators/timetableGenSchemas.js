import { z } from 'zod';
import { objectId } from './validate.js';
import { DAYS } from '../config/constants.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// Automatic timetable. apply=false only shows a preview. apply=true saves exactly the same arrangement (same seed).
export const generateTimetableSchema = z
  .object({
    semesters: z.array(objectId).min(1).max(30).optional(), // empty = every open semester of the department
    startTime: hhmm.default('09:00'),
    endTime: hhmm.default('13:00'),
    days: z.array(z.enum(DAYS)).min(1).max(7).default(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
    rooms: z.array(z.string().trim().min(1).max(50)).max(60).optional(), // empty = rooms are created from the department code
    keepExisting: z.boolean().default(false), // true: classes already on the timetable stay, only the missing ones are added
    seed: z.number().int().min(1).max(1000000).default(1), // another number gives another arrangement
    apply: z.boolean().default(false),
  })
  .refine((v) => toMin(v.endTime) - toMin(v.startTime) >= 60, { message: 'The class hours must be at least one hour', path: ['endTime'] });

export const slotOptionsQuery = z.object({ startTime: hhmm.default('09:00'), endTime: hhmm.default('13:00') });
