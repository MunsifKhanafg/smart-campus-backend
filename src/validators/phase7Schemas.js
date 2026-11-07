import { z } from 'zod';
import { objectId } from './validate.js';
import { COMPLAINT_CATEGORIES, COMPLAINT_RECIPIENTS, COMPLAINT_STATUS, ROLE_LIST } from '../config/constants.js';

const date = z.coerce.date();

// ---------- Complaints (sent as multipart/form-data, so every field arrives as a string) ----------
export const createComplaintSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES),
  recipient: z.enum(COMPLAINT_RECIPIENTS),
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
  relatedCourse: objectId.optional(),
});

export const respondSchema = z
  .object({
    message: z.string().trim().min(2).max(3000),
    status: z.enum([COMPLAINT_STATUS.IN_REVIEW, COMPLAINT_STATUS.RESOLVED, COMPLAINT_STATUS.REJECTED]),
    resolution: z.string().trim().max(3000).optional(),
  })
  .refine((v) => v.status !== COMPLAINT_STATUS.RESOLVED || (v.resolution && v.resolution.length >= 3), {
    message: 'Describe how the complaint was resolved',
    path: ['resolution'],
  });

export const complaintsQuery = z.object({ status: z.enum(Object.values(COMPLAINT_STATUS)).optional() });

// ---------- Announcements ----------
export const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    message: z.string().trim().min(2).max(5000),
    publishDate: date.optional(),
    scope: z.enum(['all', 'departments', 'users']),
    departments: z.array(objectId).max(50).optional(),
    recipients: z.array(objectId).max(200).optional(),
    roles: z.array(z.enum(ROLE_LIST)).max(5).optional(),
    meeting: z.object({ date: date.optional(), time: z.string().max(20).optional(), location: z.string().max(200).optional() }).optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((v) => v.scope !== 'departments' || v.departments?.length, { message: 'Choose at least one department', path: ['departments'] })
  .refine((v) => v.scope !== 'users' || v.recipients?.length, { message: 'Choose at least one person', path: ['recipients'] })
  .refine((v) => !(v.meeting?.time || v.meeting?.location) || v.meeting?.date, { message: 'A meeting needs a date', path: ['meeting', 'date'] });
