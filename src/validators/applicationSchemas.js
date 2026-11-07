import { z } from 'zod';
import { objectId } from './validate.js';

// Public forms are sent as multipart/form-data, so every value arrives as text. Empty text means "not given".
const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);
const optNum = z.preprocess(blankToUndefined, z.coerce.number().min(0).max(100000).optional());
const optId = z.preprocess(blankToUndefined, objectId.optional());
const labels = z.preprocess((v) => (v === undefined || v === null ? [] : [].concat(v)), z.array(z.string().trim().min(1).max(80)).max(12));

const applicationNumber = z.string().trim().toUpperCase().regex(/^APP-\d{4}-\d{5,}$/, 'Enter the application number like APP-2026-00001');

export const applySchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    fatherName: z.string().trim().min(2).max(100),
    gender: z.enum(['male', 'female', 'other']),
    dateOfBirth: z.coerce.date().refine((d) => d < new Date() && d > new Date('1950-01-01'), 'Enter a valid date of birth'),
    nationalId: z.string().trim().regex(/^[0-9-]{10,15}$/, 'Enter the CNIC / B-Form number (digits and dashes)'),
    email: z.string().trim().toLowerCase().email(),
    phone: z.string().trim().min(7).max(30),
    address: z.string().trim().min(5).max(300),
    city: z.string().trim().max(80).optional(),
    department: objectId,
    program: z.string().trim().max(150).optional(),
    secondDepartment: optId,
    matricMarks: z.coerce.number().min(0).max(100000),
    matricTotal: z.coerce.number().min(1).max(100000),
    interMarks: z.coerce.number().min(0).max(100000),
    interTotal: z.coerce.number().min(1).max(100000),
    testMarks: optNum,
    testTotal: optNum,
    declaration: z.literal('true', { errorMap: () => ({ message: 'You must confirm that the information is correct' }) }),
    labels,
  })
  .refine((v) => v.matricMarks <= v.matricTotal, { message: 'Matric marks cannot be more than the total', path: ['matricMarks'] })
  .refine((v) => v.interMarks <= v.interTotal, { message: 'Intermediate marks cannot be more than the total', path: ['interMarks'] })
  .refine((v) => (v.testMarks === undefined) === (v.testTotal === undefined), { message: 'Enter both the test marks and the test total, or neither', path: ['testTotal'] })
  .refine((v) => v.testMarks === undefined || v.testMarks <= v.testTotal, { message: 'Test marks cannot be more than the total', path: ['testMarks'] });

export const trackSchema = z.object({ applicationNumber, email: z.string().trim().toLowerCase().email() });
export const resubmitSchema = trackSchema.extend({ labels });
export const meritQuery = z.object({ department: objectId.optional() });
export const meritListQuery = meritQuery; // name used by routes/applications.js

// ---------- staff ----------
export const listApplicationsQuery = z.object({
  status: z.enum(['submitted', 'under_review', 'needs_info', 'accepted', 'rejected']).optional(),
  department: objectId.optional(),
  search: z.string().trim().max(100).optional(),
});

export const reviewApplicationSchema = z
  .object({
    status: z.enum(['under_review', 'needs_info', 'accepted', 'rejected']),
    remarks: z.string().trim().max(1000).optional(),
  })
  .refine((v) => !['needs_info', 'rejected'].includes(v.status) || !!v.remarks, {
    message: 'Write a short reason. The applicant will read it',
    path: ['remarks'],
  });

export const enrollApplicantSchema = z.object({
  rollNumber: z.string().trim().min(2).max(30),
  password: z.string().min(8).max(72),
  section: z.string().trim().min(1).max(10).optional(),
  semester: objectId.optional(),
});
