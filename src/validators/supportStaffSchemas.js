import { z } from 'zod';
import { objectId } from './validate.js';
import { STAFF_SHIFTS, STAFF_STATUS } from '../models/SupportStaff.js';

// Empty text is allowed for the optional boxes (the form sends "" when a box is left empty).
const optionalText = (max) => z.string().trim().max(max).optional();

const fields = {
  name: z.string().trim().min(2).max(100),
  fatherName: optionalText(100),
  designation: z.string().trim().min(2).max(60),
  cnic: z.union([z.literal(''), z.string().trim().regex(/^\d{5}-?\d{7}-?\d$/, 'CNIC has 13 digits, for example 12345-1234567-1')]).optional(),
  phone: optionalText(30),
  address: optionalText(250),
  joiningDate: z.union([z.null(), z.coerce.date()]).optional(),
  shift: z.enum(STAFF_SHIFTS).optional(),
  duty: optionalText(300),
  status: z.enum(STAFF_STATUS).optional(),
};

// 1234512345671 or 12345-1234567-1 -> 12345-1234567-1 (the same way everywhere, so searching and printing always match)
export const formatCnic = (raw) => {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 13 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}` : String(raw || '').trim();
};

// The principal chooses the department; an HOD's staff always go to their own department (the server ignores what the HOD sends).
export const createStaffSchema = z.object({ ...fields, department: objectId.optional() });
export const updateStaffSchema = z.object(fields).partial(); // the department never changes: delete and add again if someone moves

export const listStaffQuery = z.object({
  department: objectId.optional(),
  status: z.enum(STAFF_STATUS).optional(),
  search: z.string().trim().max(100).optional(),
});
