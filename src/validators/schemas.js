import { z } from 'zod';
import { objectId } from './validate.js';
import { ROLES, DAYS } from '../config/constants.js';

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(72),
});

const contactSchema = z
  .object({
    email: z.union([z.string().email(), z.literal('')]).optional(),
    phone: z.string().max(30).optional(),
    office: z.string().max(100).optional(),
    officeHours: z.string().max(100).optional(),
  })
  .optional();

// Teachers: the subjects they can teach, the other departments they also teach in (common subjects such as English or
// Mathematics are taught everywhere), and the weekly teaching hours the administrator allows (null = no limit).
const teachingFields = {
  subjects: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  extraDepartments: z.array(objectId).max(20).optional(),
  allDepartments: z.boolean().optional(), // common-subject teacher: any HOD may give them classes
  maxWeeklyHours: z.number().int().min(1).max(60).nullable().optional(),
};

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(150),
  code: z.string().trim().min(2).max(12),
  description: z.string().max(1000).optional(),
  contact: contactSchema,
});

export const updateDepartmentSchema = createDepartmentSchema.partial();

export const departmentStatusSchema = z.object({ status: z.enum(['active', 'archived']) });

export const assignHodSchema = z.object({ userId: objectId });

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(72),
  // Students are created from the Students page (POST /api/students) so a login and a profile always exist together.
  role: z.enum([ROLES.FINANCE_OFFICER, ROLES.TEACHER]),
  ...teachingFields,
  department: objectId.optional(),
  phone: z.string().max(30).optional(),
  qualification: z.string().trim().max(200).optional(),
});

// Own account: name, phone, qualification and email. Changing the email asks for the current password.
export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    email: z.string().email().toLowerCase().optional(),
    phone: z.string().trim().max(30).optional(),
    qualification: z.string().trim().max(200).optional(),
    currentPassword: z.string().min(1).optional(),
  })
  .refine((v) => v.email === undefined || !!v.currentPassword, {
    message: 'Enter your current password to change your email',
    path: ['currentPassword'],
  });

export const resetPasswordSchema = z.object({ temporaryPassword: z.string().min(8, 'At least 8 characters').max(72) });

// An HOD (own department) or the principal corrects a teacher's name, email, phone or qualification after a typing mistake.
export const updateUserSchema = z.object({
  ...teachingFields,
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().email().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  qualification: z.string().trim().max(200).optional(),
});

export const listUsersQuery = z.object({
  role: z.enum(Object.values(ROLES)).optional(),
  department: objectId.optional(),
  search: z.string().max(100).optional(),
  includeShared: z.enum(['true']).optional(), // also list teachers of other departments who are allowed to teach in this one
});

export const userActiveSchema = z.object({ isActive: z.boolean() });

const gradeRule = z.object({
  grade: z.string().trim().min(1).max(5),
  minPercentage: z.number().min(0).max(100),
  gpaPoints: z.number().min(0).max(4),
});

export const updateSettingsSchema = z.object({
  universityName: z.string().trim().min(2).max(150).optional(),
  campusName: z.string().trim().min(2).max(150).optional(),
  address: z.string().max(300).optional(),
  contactNumber: z.string().max(30).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  website: z.string().max(200).optional(),
  officeHours: z.string().max(100).optional(),
  currentAcademicYear: z.string().regex(/^\d{4}-\d{4}$/, 'Use format 2025-2026').optional(),
  // Days of the week on which nothing is taught anywhere (Sunday by default). The course-content scheduler never uses them.
  calendarRules: z
    .object({ weeklyHolidays: z.array(z.enum(DAYS)).max(6, 'At least one day of the week must be a teaching day').optional() })
    .optional(),
  passingPercentage: z.number().min(0).max(100).optional(),
  gradingRules: z
    .array(gradeRule)
    .min(2)
    .refine((r) => r.some((x) => x.minPercentage === 0), 'One grade must start at 0%')
    .optional(),
  feePolicy: z
    .object({ lateFeeEnabled: z.boolean().optional(), currency: z.string().length(3).toUpperCase().optional() })
    .optional(),
  admissionRules: z
    .object({
      minAttendancePercentage: z.number().min(0).max(100).optional(),
      requireFeePayment: z.boolean().optional(),
      requireDocuments: z.boolean().optional(),
      minAssignmentCompletionPercentage: z.number().min(0).max(100).optional(),
      requirePreviousSemesterPass: z.boolean().optional(),
    })
    .optional(),
  attendanceRules: z.object({ allowApprovedLeaveAsPresent: z.boolean().optional() }).optional(),
  // The bank account students send fees to (shown to logged-in students on the Fees page).
  bankAccount: z
    .object({
      bankName: z.string().trim().max(80).optional(),
      accountTitle: z.string().trim().max(120).optional(),
      accountNumber: z.string().trim().max(40).optional(),
      iban: z.string().trim().max(40).optional(),
      branch: z.string().trim().max(120).optional(),
      instructions: z.string().trim().max(600).optional(),
    })
    .optional(),
  // New-student admission portal. Dates arrive as "YYYY-MM-DD" (or null to clear them).
  admissionPortal: z
    .object({
      open: z.boolean().optional(),
      intakeName: z.string().trim().max(60).optional(),
      startDate: z.union([z.null(), z.coerce.date()]).optional(),
      deadline: z.union([z.null(), z.coerce.date()]).optional(),
      instructions: z.string().trim().max(2000).optional(),
      // Shown as a link on public pages, so only http(s) addresses are accepted (never javascript: and similar).
      externalUrl: z.union([z.literal(''), z.string().trim().url().max(300).regex(/^https?:\/\//i, 'Must start with http:// or https://')]).optional(),
      requiredDocuments: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
      // Merit list: published on this date, after the closing date. Not publishable by a checkbox any more.
      meritListDate: z.union([z.null(), z.coerce.date()]).optional(),
      meritSeats: z.number().int().min(0).max(5000).optional(),
      meritAutoPublish: z.boolean().optional(),
      interview: z
        .object({
          date: z.union([z.null(), z.coerce.date()]).optional(),
          time: z.string().trim().max(40).optional(),
          venue: z.string().trim().max(200).optional(),
          instructions: z.string().trim().max(1000).optional(),
        })
        .optional(),
    })
    .refine((v) => !v.startDate || !v.deadline || v.startDate <= v.deadline, {
      message: 'The closing date must be on or after the opening date',
      path: ['deadline'],
    })
    .refine((v) => !v.meritListDate || !v.deadline || v.meritListDate > v.deadline, {
      message: 'The merit list date must be after the closing date',
      path: ['meritListDate'],
    })
    .refine((v) => !v.meritListDate || !v.interview?.date || v.interview.date >= v.meritListDate, {
      message: 'The interview date cannot be before the merit list date',
      path: ['interview', 'date'],
    })
    .optional(),
});
