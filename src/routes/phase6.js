import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { privateUpload } from '../middleware/upload.js';
import { paymentLimiter } from '../middleware/rateLimit.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  createNoticeSchema, updateNoticeSchema, noticesQuery, statusQuery, reportQuery, cartAddSchema, manualPaymentSchema,
  refundSchema, paymentsQuery, uploadDocumentSchema, reviewSchema, documentsQuery, requestAdmissionSchema,
  admissionsQuery, courseAdmissionQuery, announcementSchema, batchParam, ledgerQuery, requestAdmissionForSchema,
  bankSubmitSchema, bankConfirmSchema, bankRejectSchema, bankListQuery,
  accountSchema, accountUpdateSchema, accountActiveSchema,
} from '../validators/phase6Schemas.js';
import {
  createNotice, listNotices, updateNotice, publishNotice, closeNotice, myFees, getCart, addToCart, removeFromCart,
  noticeStatus, outstanding, financialReport, studentLookup, studentFees, feeTypeReport,
  createAnnouncement, listAnnouncements, publishBatch, closeBatch,
} from '../controllers/feeController.js';
import { promotionLedger } from '../controllers/promotionController.js';
import { createAccount, updateAccount, setAccountActive, deleteAccount } from '../controllers/accountController.js';
import { myRequirements, studentRequirements } from '../controllers/requirementController.js';
import { listReminders, getReminder, makeReminder } from '../controllers/reminderController.js';
import { bankInfo, bankSubmit, bankList, bankConfirm, bankReject, bankProof } from '../controllers/bankController.js';
import {
  checkout, verifyPayment, mockConfirm, myPayments, getMyPayment, listPayments, manualPayment, refund, downloadReceipt,
} from '../controllers/paymentController.js';
import { uploadDocument, myDocuments, listDocuments, reviewDocument, downloadDocumentFile } from '../controllers/documentController.js';
import { myAdmissions, requestAdmission, listAdmissions, reviewAdmission, downloadAdmitCard, courseEligibility, studentAdmissions, requestAdmissionFor } from '../controllers/admissionController.js';

const { UNIVERSITY_HEAD, HOD, FINANCE_OFFICER, TEACHER, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const courseParam = validate(z.object({ courseId: objectId }), 'params');
const fileParam = validate(z.object({ id: objectId, storedName: z.string().regex(/^[a-f0-9]{32}\.[a-z0-9]{3,4}$/) }), 'params');

// ---------- Fee notices, cart, reports ----------
export const feeRouter = Router();
feeRouter.use(protect);
feeRouter.get('/mine', authorize(STUDENT), myFees);
feeRouter.get('/cart', authorize(STUDENT), getCart);
feeRouter.post('/cart', authorize(STUDENT), validate(cartAddSchema), addToCart);
feeRouter.delete('/cart/:id', authorize(STUDENT), idParam, removeFromCart);
feeRouter.get('/notices', authorize(FINANCE_OFFICER, HOD, UNIVERSITY_HEAD), validate(noticesQuery, 'query'), listNotices);
feeRouter.get('/students', authorize(FINANCE_OFFICER), validate(z.object({ search: z.string().trim().min(2).max(60) }), 'query'), studentLookup);
feeRouter.get('/students/:id/fees', authorize(FINANCE_OFFICER), idParam, studentFees);
feeRouter.post('/notices', authorize(FINANCE_OFFICER, HOD), validate(createNoticeSchema), createNotice);
feeRouter.put('/notices/:id', authorize(FINANCE_OFFICER, HOD), idParam, validate(updateNoticeSchema), updateNotice);
feeRouter.post('/notices/:id/publish', authorize(FINANCE_OFFICER, HOD), idParam, publishNotice);
feeRouter.post('/notices/:id/close', authorize(FINANCE_OFFICER, HOD), idParam, closeNotice);
feeRouter.get('/status', authorize(FINANCE_OFFICER, HOD, UNIVERSITY_HEAD), validate(statusQuery, 'query'), noticeStatus);
// The requirements form (mobile number + documents) the student fills before paying, and the same form at the office counter.
feeRouter.get('/requirements', authorize(STUDENT), myRequirements);
feeRouter.get('/students/:id/requirements', authorize(FINANCE_OFFICER), idParam, studentRequirements);
// Automatic "who has not paid yet" lists for the HODs (examination and promotion fees), plus a button to create one now.
feeRouter.get('/reminders', authorize(FINANCE_OFFICER, HOD, UNIVERSITY_HEAD), validate(z.object({ department: objectId.optional(), feeType: z.enum(['examination', 'practical', 'promotion', 'other']).optional() }), 'query'), listReminders);
feeRouter.get('/reminders/:id', authorize(FINANCE_OFFICER, HOD, UNIVERSITY_HEAD), idParam, getReminder);
feeRouter.post('/reminders', authorize(FINANCE_OFFICER, HOD), validate(z.object({ notice: objectId })), makeReminder);
// Fee announcements: one notice per semester (plus practical) created and sent together.
feeRouter.get('/announcements', authorize(FINANCE_OFFICER, HOD, UNIVERSITY_HEAD), listAnnouncements);
feeRouter.post('/announcements', authorize(FINANCE_OFFICER, HOD), validate(announcementSchema), createAnnouncement);
feeRouter.post('/batches/:batch/publish', authorize(FINANCE_OFFICER, HOD), validate(batchParam, 'params'), publishBatch);
feeRouter.post('/batches/:batch/close', authorize(FINANCE_OFFICER, HOD), validate(batchParam, 'params'), closeBatch);
// Who paid the promotion fee of every semester they went through.
feeRouter.get('/promotion-ledger', authorize(FINANCE_OFFICER, HOD, UNIVERSITY_HEAD), validate(ledgerQuery, 'query'), promotionLedger);
feeRouter.get('/outstanding', authorize(FINANCE_OFFICER, HOD, UNIVERSITY_HEAD), validate(noticesQuery, 'query'), outstanding);
feeRouter.get('/report', authorize(FINANCE_OFFICER, UNIVERSITY_HEAD), validate(reportQuery, 'query'), financialReport);
feeRouter.get('/summary', authorize(FINANCE_OFFICER, UNIVERSITY_HEAD), validate(z.object({ department: objectId.optional() }), 'query'), feeTypeReport);

// ---------- Payments (the Stripe webhook is mounted in app.js, it needs the raw body) ----------
export const paymentRouter = Router();
paymentRouter.use(protect);
paymentRouter.post('/checkout', authorize(STUDENT), paymentLimiter, checkout);
paymentRouter.get('/mine', authorize(STUDENT), myPayments);
paymentRouter.post('/manual', authorize(FINANCE_OFFICER), validate(manualPaymentSchema), manualPayment);
// Bank transfer: the student submits, the finance officer checks the statement and presses Received (or rejects).
// These fixed paths must stay above the '/:id' routes below.
paymentRouter.get('/bank-info', authorize(STUDENT, FINANCE_OFFICER, UNIVERSITY_HEAD), bankInfo);
// The finance officer's "Add account": bank, JazzCash and EasyPaisa accounts that students pay into. Only the finance officer changes them.
paymentRouter.post('/accounts', authorize(FINANCE_OFFICER), validate(accountSchema), createAccount);
paymentRouter.put('/accounts/:id', authorize(FINANCE_OFFICER), idParam, validate(accountUpdateSchema), updateAccount);
paymentRouter.patch('/accounts/:id/active', authorize(FINANCE_OFFICER), idParam, validate(accountActiveSchema), setAccountActive);
paymentRouter.delete('/accounts/:id', authorize(FINANCE_OFFICER), idParam, deleteAccount);
paymentRouter.post('/bank', authorize(STUDENT), paymentLimiter, ...privateUpload('bank-proofs', { maxMB: 8, maxFiles: 1 }), validate(bankSubmitSchema), bankSubmit);
paymentRouter.get('/bank', authorize(FINANCE_OFFICER, UNIVERSITY_HEAD), validate(bankListQuery, 'query'), bankList);
paymentRouter.post('/:id/bank/confirm', authorize(FINANCE_OFFICER), idParam, validate(bankConfirmSchema), bankConfirm);
paymentRouter.post('/:id/bank/reject', authorize(FINANCE_OFFICER), idParam, validate(bankRejectSchema), bankReject);
paymentRouter.get('/:id/bank/proof', authorize(STUDENT, FINANCE_OFFICER, UNIVERSITY_HEAD), idParam, bankProof);
paymentRouter.get('/', authorize(FINANCE_OFFICER, UNIVERSITY_HEAD), validate(paymentsQuery, 'query'), listPayments);
paymentRouter.get('/:id', authorize(STUDENT), idParam, getMyPayment);
paymentRouter.post('/:id/verify', authorize(STUDENT), paymentLimiter, idParam, verifyPayment);
paymentRouter.post('/:id/mock-confirm', authorize(STUDENT), paymentLimiter, idParam, mockConfirm);
paymentRouter.post('/:id/refund', authorize(FINANCE_OFFICER), idParam, validate(refundSchema), refund);
paymentRouter.get('/:id/receipt', authorize(STUDENT, FINANCE_OFFICER, UNIVERSITY_HEAD), idParam, downloadReceipt);

// ---------- Student documents ----------
export const documentRouter = Router();
documentRouter.use(protect);
documentRouter.post('/', authorize(STUDENT), ...privateUpload('documents', { maxMB: 8, maxFiles: 3 }), validate(uploadDocumentSchema), uploadDocument);
documentRouter.get('/mine', authorize(STUDENT), myDocuments);
documentRouter.get('/', authorize(HOD, UNIVERSITY_HEAD), validate(documentsQuery, 'query'), listDocuments);
documentRouter.patch('/:id/review', authorize(HOD), idParam, validate(reviewSchema), reviewDocument);
documentRouter.get('/:id/files/:storedName', authorize(STUDENT, HOD, UNIVERSITY_HEAD), fileParam, downloadDocumentFile);

// ---------- Examination admission ----------
export const admissionRouter = Router();
admissionRouter.use(protect);
admissionRouter.get('/mine', authorize(STUDENT), myAdmissions);
admissionRouter.post('/request', authorize(STUDENT), validate(requestAdmissionSchema), requestAdmission);
// At the office: the finance officer (or an HOD, own department) applies for a student who cannot use the online system.
admissionRouter.get('/student/:id', authorize(FINANCE_OFFICER, HOD), idParam, studentAdmissions);
admissionRouter.post('/request-for', authorize(FINANCE_OFFICER, HOD), validate(requestAdmissionForSchema), requestAdmissionFor);
admissionRouter.get('/', authorize(HOD, UNIVERSITY_HEAD, FINANCE_OFFICER), validate(admissionsQuery, 'query'), listAdmissions);
admissionRouter.get('/course/:courseId', authorize(TEACHER, HOD, UNIVERSITY_HEAD), courseParam, validate(courseAdmissionQuery, 'query'), courseEligibility);
admissionRouter.patch('/:id/review', authorize(HOD), idParam, validate(reviewSchema), reviewAdmission);
admissionRouter.get('/:id/admit-card', authorize(STUDENT, HOD, UNIVERSITY_HEAD, FINANCE_OFFICER), idParam, downloadAdmitCard);
