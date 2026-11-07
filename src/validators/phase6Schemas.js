import { z } from 'zod';
import { objectId } from './validate.js';
import { FEE_TYPES, FEE_NOTICE_STATUS, PAYMENT_STATUS, REVIEW_STATUS } from '../config/constants.js';

const date = z.coerce.date();

// ---------- Fee notices ----------
const noticeFields = {
  title: z.string().trim().min(2).max(200),
  feeType: z.enum(FEE_TYPES).default('examination'),
  amount: z.number().min(0).max(10000000),
  startDate: date,
  dueDate: date,
  lateFee: z.number().min(0).max(10000000).default(0),
  lateDueDate: date.nullable().optional(),
  practicalFee: z.number().min(0).max(10000000).optional(), // per practical
  practicalLateFee: z.number().min(0).max(10000000).optional(), // per practical, after the normal deadline
  maxPracticals: z.number().int().min(0).max(6).optional(),
  requirements: z.string().max(3000).optional(),
  requiredDocuments: z.array(z.string().trim().toLowerCase().min(2).max(60)).max(10).optional(),
};

export const createNoticeSchema = z.object({
  department: objectId.optional(), // finance officer / head choose it; an HOD is locked to their own
  semester: objectId,
  examination: objectId.nullable().optional(),
  ...noticeFields,
});

// A fee announcement: one line per semester. Each line can carry its own fee, practical fee, late fee and dates.
const money = z.number().min(0).max(10000000);
const announcementLine = z.object({
  semester: objectId,
  amount: money,
  practicalFee: money.default(0), // per practical. The student chooses how many practicals they have (up to maxPracticals)
  lateFee: money.default(0),
  practicalLateFee: money.default(0), // per practical
  maxPracticals: z.number().int().min(0).max(6).default(3),
  startDate: date,
  dueDate: date,
  lateDueDate: date.nullable().optional(),
  requirements: z.string().max(3000).optional(),
  requiredDocuments: z.array(z.string().trim().toLowerCase().min(2).max(60)).max(10).optional(),
});
export const announcementSchema = z.object({
  title: z.string().trim().min(3).max(190),
  feeType: z.enum(['examination', 'promotion', 'other']).default('examination'),
  examType: z.enum(['midterm', 'final', 'other']).nullable().optional(),
  lines: z.array(announcementLine).min(1).max(80),
  publish: z.boolean().default(false),
});
export const batchParam = z.object({ batch: objectId });
export const ledgerQuery = z.object({
  department: objectId.optional(),
  semesterNumber: z.coerce.number().int().min(1).max(12).optional(),
  unpaidOnly: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(60).optional(),
});

export const updateNoticeSchema = z.object(noticeFields).partial();
export const noticesQuery = z.object({
  department: objectId.optional(),
  semester: objectId.optional(),
  status: z.enum(Object.values(FEE_NOTICE_STATUS)).optional(),
});
export const statusQuery = z.object({ notice: objectId });
export const reportQuery = z.object({ from: date.optional(), to: date.optional(), department: objectId.optional() });

// ---------- Cart and payments ----------
export const cartAddSchema = z.object({ notice: objectId, practicals: z.number().int().min(0).max(6).default(0) });
const payLine = z.object({ notice: objectId, practicals: z.number().int().min(0).max(6).default(0) });
export const manualPaymentSchema = z
  .object({
    student: objectId, // student User id
    notices: z.array(objectId).min(1).max(10).optional(), // older form: just the notice ids
    items: z.array(payLine).min(1).max(10).optional(), // with the number of practicals of each fee
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.items || v.notices, { message: 'Choose at least one fee', path: ['items'] });

// ---------- Bank transfer ----------
export const bankInfoSchema = z.object({
  bankName: z.string().trim().max(80).default(''),
  accountTitle: z.string().trim().max(120).default(''),
  accountNumber: z.string().trim().max(40).default(''),
  iban: z.string().trim().max(40).default(''),
  branch: z.string().trim().max(120).default(''),
  instructions: z.string().trim().max(600).default(''),
});
// Sent as multipart/form-data (there is a proof file), so every field arrives as text. `items` is a JSON list.
export const bankSubmitSchema = z.object({
  items: z.string().min(2).max(2000),
  bankName: z.string().trim().min(2).max(80),
  reference: z.string().trim().min(3).max(80),
  transferDate: date,
  note: z.string().max(500).optional(),
});
export const bankConfirmSchema = z.object({ receivedAmount: z.number().min(0).optional(), note: z.string().max(500).optional() });
export const bankRejectSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const bankListQuery = z.object({ status: z.enum(['pending', 'paid', 'failed', 'all']).default('pending'), search: z.string().max(60).optional() });
export const refundSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const paymentsQuery = z.object({
  status: z.enum(Object.values(PAYMENT_STATUS)).optional(),
  department: objectId.optional(),
  search: z.string().max(60).optional(),
  from: date.optional(),
  to: date.optional(),
});

// ---------- Documents and admission ----------
export const uploadDocumentSchema = z.object({ type: z.string().trim().toLowerCase().min(2).max(60), note: z.string().max(500).optional() });

const reviewStatus = z.enum([REVIEW_STATUS.APPROVED, REVIEW_STATUS.REJECTED, REVIEW_STATUS.REQUIRES_CORRECTION]);
export const reviewSchema = z
  .object({ status: reviewStatus, remarks: z.string().max(1000).optional() })
  .refine((v) => v.status === REVIEW_STATUS.APPROVED || (v.remarks && v.remarks.trim().length >= 3), {
    message: 'Please write a short reason for the student',
    path: ['remarks'],
  });
export const documentsQuery = z.object({ status: z.enum(Object.values(REVIEW_STATUS)).optional() });

export const requestAdmissionSchema = z.object({ examination: objectId });
export const admissionsQuery = z.object({ examination: objectId.optional(), status: z.enum(Object.values(REVIEW_STATUS)).optional() });
export const courseAdmissionQuery = z.object({ examination: objectId });
