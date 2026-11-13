import { z } from 'zod';
import { objectId } from './validate.js';

// Request checks of the library module. Controllers receive the cleaned values (see validate.js).

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const text = (max) => z.string().trim().max(max);
// A form sends "" for an empty number box: that means "no value".
const optNumber = (min, max) =>
  z.preprocess((v) => (v === '' || v === undefined || v === null ? null : Number(v)), z.number().min(min).max(max).nullable());
const authors = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string().trim().min(1).max(120)).max(10)
);
const flag = z.enum(['true', 'false']).optional();
const paging = { page: z.coerce.number().int().min(1).max(10000).optional(), limit: z.coerce.number().int().min(1).max(100).optional() };

// ---------- Books ----------
export const bookSchema = z.object({
  bookId: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,28}$/, 'Book ID: letters, numbers and "-" only').optional().or(z.literal('').transform(() => undefined)),
  title: z.string().trim().min(1, 'Enter the title').max(250),
  authors: authors.default([]),
  isbn: text(20).default(''),
  category: z.string().trim().min(1, 'Choose or type a category').max(80),
  publisher: text(120).default(''),
  edition: text(40).default(''),
  year: optNumber(1000, 2200).default(null),
  language: text(40).default('English'),
  pages: optNumber(1, 20000).default(null),
  shelf: text(60).default(''),
  description: text(1500).default(''),
  price: z.coerce.number().min(0).max(10000000).default(0),
  department: objectId.nullable().optional().or(z.literal('').transform(() => null)),
  semesterNumber: optNumber(1, 12).default(null), // which semester the book is for (up to 30 books per semester)
  copies: z.coerce.number().int().min(1).max(200).default(1), // only used when the book is created
});
export const bookUpdateSchema = bookSchema.partial();

export const booksQuery = z.object({
  q: text(100).optional(),
  category: text(80).optional(),
  available: flag,
  semester: z.coerce.number().int().min(1).max(12).optional(),
  status: z.enum(['active', 'removed', 'all']).optional(),
  ...paging,
});
export const addCopiesSchema = z.object({ count: z.coerce.number().int().min(1).max(200), note: text(300).optional() });
export const copyStatusSchema = z.object({ status: z.enum(['available', 'damaged', 'lost', 'withdrawn']), note: text(300).optional() });
export const labelsQuery = z.object({ book: objectId.optional() });

// ---------- Desk: issue, return, renew, lost, money ----------
export const issueSchema = z.object({
  student: z.string().trim().min(1, 'Enter the student roll number').max(40),
  code: z.string().trim().min(2, 'Scan or type the book code').max(120),
  days: z.coerce.number().int().min(1).max(120).optional(),
});
export const returnSchema = z
  .object({
    code: z.string().trim().max(120).optional(),
    loanId: objectId.optional(),
    condition: z.enum(['good', 'damaged']).default('good'),
    damageFee: z.coerce.number().min(0).max(10000000).default(0),
    note: text(300).default(''),
  })
  .refine((v) => v.code || v.loanId, { message: 'Scan or type the book code', path: ['code'] });
export const renewSchema = z.object({ loanId: objectId });
export const lostSchema = z.object({ loanId: objectId, amount: z.coerce.number().min(0).max(10000000).optional(), note: text(300).default('') });
export const paymentSchema = z.object({
  loanId: objectId,
  kind: z.enum(['payment', 'waiver']),
  amount: z.coerce.number().min(0.01).max(10000000),
  note: text(300).default(''),
});
export const lookupQuery = z.object({ code: z.string().trim().min(1).max(200) });

// ---------- Lists ----------
export const loansQuery = z.object({
  status: z.enum(['open', 'overdue', 'returned', 'lost', 'unpaid', 'all']).optional(),
  q: text(100).optional(),
  department: objectId.optional(),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});
export const studentsQuery = z.object({ q: text(100).optional(), holding: flag });
export const reservationsQuery = z.object({ status: z.enum(['open', 'waiting', 'ready', 'fulfilled', 'cancelled', 'expired', 'all']).optional(), ...paging });
export const messagesQuery = z.object({ status: text(20).optional(), kind: text(30).optional(), ...paging });
export const activityQuery = z.object({ q: text(60).optional(), ...paging });
export const complaintsQuery = z.object({ status: z.enum(['open', 'in_review', 'resolved', 'rejected']).optional() });

// ---------- Rules ----------
export const rulesSchema = z
  .object({
    loanDays: z.coerce.number().int().min(1).max(120),
    maxBooksPerStudent: z.coerce.number().int().min(1).max(30),
    maxRenewals: z.coerce.number().int().min(0).max(10),
    renewDays: z.coerce.number().int().min(1).max(60),
    blockIssueIfOverdue: z.boolean(),
    blockIssueIfFineUnpaid: z.boolean(),
    finePerDay: z.coerce.number().min(0).max(100000),
    graceDays: z.coerce.number().int().min(0).max(30),
    maxFinePerBook: optNumber(0, 100000000),
    lostPenaltyMultiplier: z.coerce.number().min(0).max(10),
    lostProcessingFee: z.coerce.number().min(0).max(10000000),
    smsEnabled: z.boolean(),
    reminderBeforeDays: z.array(z.coerce.number().int().min(1).max(60)).max(6),
    remindOnDueDay: z.boolean(),
    overdueReminderEveryDays: z.coerce.number().int().min(1).max(30),
    maxOverdueReminders: z.coerce.number().int().min(0).max(100),
    complaintAfterOverdueDays: z.coerce.number().int().min(1).max(365),
    principalAfterOverdueDays: z.coerce.number().int().min(1).max(730),
    reservationHoldDays: z.coerce.number().int().min(1).max(30),
    maxReservationsPerStudent: z.coerce.number().int().min(1).max(20),
    categories: z.array(z.string().trim().min(1).max(80)).max(200),
  })
  .partial()
  .refine((v) => !(v.complaintAfterOverdueDays && v.principalAfterOverdueDays) || v.principalAfterOverdueDays >= v.complaintAfterOverdueDays, {
    message: 'The principal is informed after the department, so this number cannot be smaller',
    path: ['principalAfterOverdueDays'],
  });

// ---------- Student ----------
export const reserveSchema = z.object({ book: objectId });

// ---------- Reports ----------
export const REPORT_TYPES = ['inventory', 'issued', 'overdue', 'history', 'fines', 'lost-damaged', 'students'];
export const reportParams = z.object({ type: z.enum(REPORT_TYPES) });
export const reportQuery = z.object({
  format: z.enum(['json', 'pdf', 'xlsx']).default('json'),
  from: day.optional(),
  to: day.optional(),
  department: objectId.optional(),
  category: text(80).optional(),
});
