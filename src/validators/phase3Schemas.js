import { z } from 'zod';
import { objectId } from './validate.js';
import { DAYS, STUDENT_STATUS, CALENDAR_EVENT_TYPES } from '../config/constants.js';

const date = z.coerce.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// ---------- Students ----------
const profileFields = {
  section: z.string().trim().min(1).max(10).optional(),
  admissionYear: z.number().int().min(2000).max(2100).optional(),
  dateOfBirth: date.optional(),
  guardianName: z.string().trim().max(100).optional(),
  guardianPhone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
};

export const createStudentSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(72),
  phone: z.string().max(30).optional(),
  rollNumber: z.string().trim().min(2).max(30),
  department: objectId.optional(), // only the University Head sends this; an HOD is locked to their own department
  semester: objectId.optional(),
  ...profileFields,
});

// The HOD corrects typing mistakes here, so nobody has to delete a student and add them again.
export const updateStudentSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120).optional(),
  rollNumber: z.string().trim().min(2).max(30).optional(),
  name: z.string().trim().min(2).max(100).optional(),
  phone: z.string().max(30).optional(),
  ...profileFields,
});

export const listStudentsQuery = z.object({
  department: objectId.optional(),
  semester: objectId.optional(),
  section: z.string().trim().max(10).optional(),
  status: z.enum(Object.values(STUDENT_STATUS)).optional(),
  search: z.string().max(100).optional(),
});

export const studentStatusSchema = z.object({ status: z.enum(Object.values(STUDENT_STATUS)) });

export const assignSemesterSchema = z.object({
  semester: objectId,
  students: z.array(objectId).min(1).max(500), // StudentProfile ids
});

// ---------- Enrollment ----------
export const enrollSchema = z.object({ students: z.array(objectId).min(1).max(500) }); // student User ids

// ---------- Timetable ----------
export const createSlotSchema = z
  .object({
    course: objectId,
    room: z.string().trim().min(1).max(50),
    day: z.enum(DAYS),
    startTime: hhmm,
    endTime: hhmm,
  })
  .refine((v) => toMin(v.endTime) > toMin(v.startTime), { message: 'End time must be after the start time', path: ['endTime'] });

// The course of a slot never changes. To move a class to another course, delete it and add a new one.
export const updateSlotSchema = z.object({
  room: z.string().trim().min(1).max(50).optional(),
  day: z.enum(DAYS).optional(),
  startTime: hhmm.optional(),
  endTime: hhmm.optional(),
});

// ---------- Academic calendar ----------
export const createEventSchema = z
  .object({
    title: z.string().trim().min(2).max(150),
    type: z.enum(CALENDAR_EVENT_TYPES),
    startDate: date,
    endDate: date,
    description: z.string().max(1000).optional(),
    department: objectId.nullable().optional(), // head only; null = whole university
    semester: objectId.nullable().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'End date cannot be before the start date', path: ['endDate'] });

export const updateEventSchema = z.object({
  title: z.string().trim().min(2).max(150).optional(),
  type: z.enum(CALENDAR_EVENT_TYPES).optional(),
  startDate: date.optional(),
  endDate: date.optional(),
  description: z.string().max(1000).optional(),
  semester: objectId.nullable().optional(),
});

export const listEventsQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  department: objectId.optional(),
  semester: objectId.optional(),
});

export const myCoursesQuery = z.object({ all: z.enum(['true', 'false']).optional() });

export const notificationsQuery = z.object({ unread: z.enum(['true', 'false']).optional() });
