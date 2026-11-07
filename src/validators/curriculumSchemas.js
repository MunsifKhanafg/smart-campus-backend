import { z } from 'zod';
import { objectId } from './validate.js';

// ---------- Curriculum review (the draft the administrator edits before approving) ----------
const subject = z.object({
  code: z.string().trim().min(2).max(20),
  title: z.string().trim().min(2).max(150),
  creditHours: z.coerce.number().int().min(1).max(6),
  outline: z.string().max(5000).optional(), // course contents; without this line zod would silently drop it when the Head edits the draft
});

const semester = z.object({
  number: z.coerce.number().int().min(1).max(12),
  subjects: z.array(subject).max(40),
});

const program = z.object({
  name: z.string().trim().min(2).max(150),
  department: objectId.nullable().optional(),
  semesters: z.array(semester).max(12),
});

export const draftSchema = z.object({ programs: z.array(program).max(20) });
export const programsQuery = z.object({ department: objectId.optional() });

// ---------- HOD: assign a teacher to a subject of a semester ----------
export const boardQuery = z.object({ semester: objectId, program: objectId.optional() });

// Create every class of the semester from the approved curriculum in one step (no teacher yet).
export const generateCoursesSchema = z.object({
  semester: objectId,
  program: objectId,
  sections: z.array(z.string().trim().toUpperCase().min(1).max(10)).min(1).max(8).default(['A']),
});

export const assignSubjectSchema = z.object({
  semester: objectId,
  program: objectId,
  code: z.string().trim().min(2).max(20),
  section: z.string().trim().toUpperCase().max(10).default('A'),
  teacher: objectId.nullable(),
});
