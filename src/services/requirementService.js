import StudentDocument from '../models/StudentDocument.js';
import User from '../models/User.js';
import { ApiError } from '../utils/apiHelpers.js';
import { normalizePhone } from './smsService.js';

// "Requirements" = what a student must provide before paying an examination / promotion fee:
//   1. a mobile number (the payment confirmation SMS goes to it), and
//   2. every document listed on the fee notice (for example transcript, photo). The student uploads them on the Documents
//      page; at the office the finance officer ticks "received at the office" for papers the student handed over.
// The result is stored on the payment, so the finance officer sees it next to the money.

const RANK = { approved: 4, pending: 3, requires_correction: 2, rejected: 1 };

export const requiredTypes = (notices) => [...new Set(notices.flatMap((n) => n.requiredDocuments || []))];

// Best state of each required document, given the student's uploaded documents (pure, unit tested).
// 'missing' = nothing uploaded at all. A document that is only waiting for review ('pending') is accepted for payment:
// the HOD reviews documents separately for the examination admission.
export const documentStates = (required, docs) =>
  required.map((type) => {
    const mine = docs.filter((d) => d.type === type);
    if (!mine.length) return { type, status: 'missing' };
    const best = [...mine].sort((a, b) => (RANK[b.status] || 0) - (RANK[a.status] || 0))[0];
    return { type, status: best.status };
  });

export const buildRequirements = async ({ studentId, notices, phone, receivedAtOffice = [], filledBy = null }) => {
  const types = requiredTypes(notices);
  const docs = types.length ? await StudentDocument.find({ student: studentId, type: { $in: types } }).select('type status').lean() : [];
  const handedIn = new Set(receivedAtOffice.map((t) => String(t).trim().toLowerCase()));
  const documents = documentStates(types, docs).map((d) => (d.status === 'missing' && handedIn.has(d.type) ? { type: d.type, status: 'received_at_office' } : d));
  return {
    phone,
    text: notices.map((n) => n.requirements).filter(Boolean).join(' | ').slice(0, 1000),
    documents,
    filledAt: new Date(),
    filledBy,
  };
};

export const missingDocuments = (requirements) => requirements.documents.filter((d) => d.status === 'missing').map((d) => d.type);

export const assertRequirementsMet = (requirements, atOffice = false) => {
  const missing = missingDocuments(requirements);
  if (!missing.length) return;
  throw ApiError.badRequest(
    atOffice
      ? `Tick "received at the office" for these documents or ask the student to bring them: ${missing.join(', ')}`
      : `Upload these documents in the requirements step, then pay: ${missing.join(', ')}`
  );
};

// The mobile number for the payment SMS: the one just typed, or the one already saved. A newly typed number is saved on the
// account, so next time the student is not asked again.
export const resolvePhone = async (userId, given) => {
  const user = await User.findById(userId).select('phone');
  if (!user) throw ApiError.notFound('Student not found');
  const typed = given ? String(given).trim() : '';
  const candidate = typed || user.phone;
  if (!normalizePhone(candidate)) {
    throw ApiError.badRequest('Enter a valid mobile number (for example 0300 1234567). The payment confirmation SMS is sent to it');
  }
  if (typed && typed !== user.phone) {
    user.phone = typed;
    await user.save({ validateBeforeSave: false });
  }
  return user.phone;
};
