import { z } from 'zod';
import { objectId } from './validate.js';
import { EXAM_TYPES } from '../config/constants.js';

const date = z.coerce.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// ---------- Examination sessions ----------
export const listExamsQuery = z.object({ department: objectId.optional(), semester: objectId.optional() });

export const createExamSchema = z
  .object({
    semester: objectId,
    name: z.string().trim().min(2).max(150),
    type: z.enum(EXAM_TYPES),
    description: z.string().max(1000).optional(),
    startDate: date,
    endDate: date,
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'End date cannot be before the start date', path: ['endDate'] });

export const updateExamSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  type: z.enum(EXAM_TYPES).optional(),
  description: z.string().max(1000).optional(),
  startDate: date.optional(),
  endDate: date.optional(),
});

// ---------- Papers (date sheet rows) ----------
export const createPaperSchema = z
  .object({
    course: objectId,
    date,
    startTime: hhmm,
    endTime: hhmm,
    room: z.string().trim().min(1).max(50),
    maxMarks: z.number().min(1).max(1000),
    passingMarks: z.number().min(0),
  })
  .refine((v) => toMin(v.endTime) > toMin(v.startTime), { message: 'End time must be after the start time', path: ['endTime'] })
  .refine((v) => v.passingMarks <= v.maxMarks, { message: 'Passing marks cannot be more than maximum marks', path: ['passingMarks'] });

export const updatePaperSchema = z.object({
  date: date.optional(),
  startTime: hhmm.optional(),
  endTime: hhmm.optional(),
  room: z.string().trim().min(1).max(50).optional(),
  maxMarks: z.number().min(1).max(1000).optional(),
  passingMarks: z.number().min(0).optional(),
});

export const paperParams = z.object({ id: objectId, paperId: objectId });

// ---------- Marks ----------
export const marksQuery = z.object({ examination: objectId });

export const saveMarksSchema = z.object({
  examination: objectId,
  entries: z
    .array(z.object({ student: objectId, marks: z.number().min(0).nullable().optional(), absent: z.boolean().optional() }))
    .min(1)
    .max(500),
  submit: z.boolean().optional(),
});

export const unlockMarksSchema = z.object({ examination: objectId, course: objectId });

// ---------- Public result check ----------
export const publicResultSchema = z.object({
  rollNumber: z.string().trim().min(2).max(30),
  dateOfBirth: date,
  examination: objectId.optional(),
});
