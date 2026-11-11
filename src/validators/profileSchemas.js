import { z } from 'zod';

const thisYear = new Date().getFullYear();
const text = (max) => z.string().trim().max(max);
const year = z.coerce.number().int().min(1950).max(thisYear + 1);

export const EDUCATION_LEVELS = ['matric', 'intermediate', 'bachelors', 'masters', 'mphil', 'phd', 'postdoc', 'diploma', 'other'];

const educationEntry = z.object({
  level: z.enum(EDUCATION_LEVELS),
  degree: z.string().trim().min(2).max(120), // e.g. "MS Computer Science"
  field: text(120).optional(), // e.g. "Artificial Intelligence"
  institution: z.string().trim().min(2).max(150),
  year: year.optional().nullable(),
  grade: text(40).optional(), // e.g. "CGPA 3.6" or "First division"
});

const experienceEntry = z.object({
  title: z.string().trim().min(2).max(120), // e.g. "Lecturer"
  organization: z.string().trim().min(2).max(150),
  fromYear: year.optional().nullable(),
  toYear: year.optional().nullable(), // empty = until now
  details: text(500).optional(),
});

// Everything is optional: the person (or the HOD / principal) fills in what is known. Sending a list replaces the whole list.
export const updateProfileSchema = z
  .object({
    designation: text(100),
    gender: z.enum(['', 'male', 'female', 'other']),
    dateOfBirth: z.union([z.literal(''), z.coerce.date()]).nullable(),
    joiningDate: z.union([z.literal(''), z.coerce.date()]).nullable(),
    address: text(250),
    city: text(60),
    experienceYears: z.number().int().min(0).max(60).nullable(),
    bio: text(1500),
    education: z.array(educationEntry).max(15),
    experience: z.array(experienceEntry).max(20),
  })
  .partial();
