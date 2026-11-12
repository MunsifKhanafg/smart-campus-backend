import { z } from 'zod';
import { objectId } from './validate.js';
import { SEMESTER_STATUS, COURSE_STATUS, DAYS } from '../config/constants.js';

const date = z.coerce.date();

// ---------- Semesters ----------
// The end date can be left out: the server calculates it from the start date and durationWeeks
// (services/semesterDates.js) and calculates it again whenever either of them changes. Typing an end date makes it manual.
const durationWeeks = z.number().int().min(1).max(52);

// The start date can be left out too: the server then takes the next semester from the ACADEMIC CALENDAR
// (services/semesterFromCalendar.js): its start, and its end (the calendar's "semester ends" or the end of the finals).
export const createSemesterSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    number: z.number().int().min(1).max(12),
    academicYear: z.string().regex(/^\d{4}-\d{4}$/, 'Use format 2025-2026'),
    startDate: date.optional(),
    durationWeeks: durationWeeks.optional(),
    endDate: date.optional(),
  })
  .refine((v) => !v.endDate || !v.startDate || v.endDate > v.startDate, { message: 'End date must be after the start date', path: ['endDate'] })
  .refine((v) => !v.endDate || v.startDate, { message: 'Give the start date too, or leave both empty to use the academic calendar', path: ['startDate'] });

export const updateSemesterSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  number: z.number().int().min(1).max(12).optional(),
  academicYear: z.string().regex(/^\d{4}-\d{4}$/, 'Use format 2025-2026').optional(),
  startDate: date.optional(),
  durationWeeks: durationWeeks.optional(),
  endDate: date.optional(),
});

export const semesterStatusSchema = z.object({ status: z.enum(Object.values(SEMESTER_STATUS)) });

// toSemester = the next semester. students = StudentProfile ids chosen by the HOD (omit to move everyone).
export const promoteSemesterSchema = z.object({
  toSemester: objectId,
  students: z.array(objectId).min(1).max(1000).optional(),
});

export const listSemestersQuery = z.object({
  department: objectId.optional(),
  status: z.enum(Object.values(SEMESTER_STATUS)).optional(),
});

// ---------- Courses ----------
const courseFields = {
  title: z.string().trim().min(2).max(150),
  code: z.string().trim().min(2).max(20),
  creditHours: z.number().int().min(1).max(6),
  // Hours per week when they differ from the credit hours. null = same as the credit hours. A teacher may hold any number
  // of classes: only time clashes (and the teacher's own weekly limit, if one was set) are refused.
  weeklyClasses: z.number().int().min(1).max(40).nullable().optional(),
  // The weekdays the teacher really teaches this class (empty = taken from the timetable).
  teachingDays: z.array(z.enum(DAYS)).max(7).optional(),
  description: z.string().max(2000).optional(),
  outline: z.string().max(10000).optional(),
  section: z.string().trim().min(1).max(10).optional(),
  startDate: date.optional(),
  endDate: date.optional(),
};

export const createCourseSchema = z.object({
  ...courseFields,
  semester: objectId,
  teacher: objectId.optional(), // can be assigned later
});

// Department and semester can never be changed after creation (keeps records consistent).
export const updateCourseSchema = z.object(courseFields).partial();

export const assignTeacherSchema = z.object({ teacher: objectId.nullable() });

export const courseStatusSchema = z.object({ status: z.enum(Object.values(COURSE_STATUS)) });

export const listCoursesQuery = z.object({
  department: objectId.optional(),
  semester: objectId.optional(),
  teacher: objectId.optional(),
  status: z.enum(Object.values(COURSE_STATUS)).optional(),
});
