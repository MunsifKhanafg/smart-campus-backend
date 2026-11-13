import mongoose from 'mongoose';
import Book from '../models/Book.js';
import BookCopy from '../models/BookCopy.js';
import LibraryLoan from '../models/LibraryLoan.js';
import LibraryReservation from '../models/LibraryReservation.js';
import LibraryRules from '../models/LibraryRules.js';
import LibraryMessage from '../models/LibraryMessage.js';
import Complaint from '../models/Complaint.js';
import Counter from '../models/Counter.js';
import AuditLog from '../models/AuditLog.js';
import StudentProfile from '../models/StudentProfile.js';
import StaffAttendance from '../models/StaffAttendance.js';
import StaffAttendanceRules from '../models/StaffAttendanceRules.js';
import UniversitySettings from '../models/UniversitySettings.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import { ApiError } from '../utils/apiHelpers.js';
import { notifyUsers } from '../utils/notify.js';
import { smsToUser } from './smsService.js';
import { localNow, addDays } from './staffAttendanceRules.js';
import {
  diffDays, dueDayFrom, calcFine, loanBalance, lostPenalty, reminderDecision, escalationStage, makeCopyCode, makeBookId, normalizeCode, smsText, escapeRegex, maskPhone,
} from './libraryRules.js';
import { ROLES, BOOK_COPY_STATUS as CS, LOAN_STATUS as LS, RESERVATION_STATUS as RS } from '../config/constants.js';

// ============================================================================================================
// The library: books, copies, loans, fines, reservations, automatic reminders and complaints.
// The pure rules (fine arithmetic, which reminder is due, SMS texts) are in libraryRules.js and are unit tested.
//
// Two ideas keep it safe:
//  * Every change that two people could make at the same time (issuing a copy, returning it, claiming a reminder, filing a complaint)
//    is ONE atomic database update with a condition, so it can only happen once.
//  * The copies are the truth. The counters on Book (available, issued ...) are recomputed from them after every change.
// ============================================================================================================

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const HEX24 = /^[a-f\d]{24}$/i;
const authorsText = (b) => (b?.authors?.length ? b.authors.join(', ') : 'unknown author');

// ---------------------------------------------------------------------------------------------------------------------------
// Today, rules, money
// ---------------------------------------------------------------------------------------------------------------------------
export const libraryToday = async () => {
  const r = await StaffAttendanceRules.getRules(); // the same college time zone as the attendance module
  return localNow(new Date(), r.timezone).dateKey;
};
export const getCurrency = async () => (await UniversitySettings.findOne({ key: 'global' }).select('feePolicy').lean())?.feePolicy?.currency || 'PKR';

export const rulesView = (r) => ({
  loanDays: r.loanDays, maxBooksPerStudent: r.maxBooksPerStudent, maxRenewals: r.maxRenewals, renewDays: r.renewDays,
  blockIssueIfOverdue: r.blockIssueIfOverdue, blockIssueIfFineUnpaid: r.blockIssueIfFineUnpaid,
  finePerDay: r.finePerDay, graceDays: r.graceDays, maxFinePerBook: r.maxFinePerBook, lostPenaltyMultiplier: r.lostPenaltyMultiplier, lostProcessingFee: r.lostProcessingFee,
  smsEnabled: r.smsEnabled, reminderBeforeDays: r.reminderBeforeDays, remindOnDueDay: r.remindOnDueDay, overdueReminderEveryDays: r.overdueReminderEveryDays, maxOverdueReminders: r.maxOverdueReminders,
  complaintAfterOverdueDays: r.complaintAfterOverdueDays, principalAfterOverdueDays: r.principalAfterOverdueDays,
  reservationHoldDays: r.reservationHoldDays, maxReservationsPerStudent: r.maxReservationsPerStudent, categories: r.categories || [],
});

// ---------------------------------------------------------------------------------------------------------------------------
// Activity log (the existing AuditLog collection; every library action starts with "library.")
// ---------------------------------------------------------------------------------------------------------------------------
export const libLog = (actor, action, entity, entityId, meta = {}, ip = '') =>
  AuditLog.create({ actor: actor?._id, actorRole: actor?.role || 'system', action: `library.${action}`, entity, entityId, meta, ip }).catch((err) => console.error('Library log failed:', err.message));

const controllerIds = () => User.find({ role: ROLES.LIBRARY_CONTROLLER, isActive: true }).distinct('_id');
const principalIds = () => User.find({ role: ROLES.UNIVERSITY_HEAD, isActive: true }).distinct('_id');

// ---------------------------------------------------------------------------------------------------------------------------
// Messages to the student: in-app notification + SMS, logged, and sent only once per (loan, kind, key)
// ---------------------------------------------------------------------------------------------------------------------------
const MESSAGE_TITLE = {
  issued: 'Library: book issued', before_due: 'Library: book due soon', due_today: 'Library: book due today', overdue: 'Library: book overdue', returned: 'Library: book returned',
  lost: 'Library: book recorded as lost', reservation_ready: 'Library: your reserved book is ready', reservation_expired: 'Library: reservation expired', fine: 'Library: payment received',
};

export const sendLibraryMessage = async ({ loan = null, student, kind, key = '', text, rules = null }) => {
  const r = rules || (await LibraryRules.getRules());
  let log;
  try {
    // Claiming the message and sending it are separate: the unique index is what stops a second copy.
    log = await LibraryMessage.create({ loan: loan?._id || loan || null, student, kind, key, text: String(text).slice(0, 400), status: 'pending' });
  } catch (err) {
    if (err.code === 11000) return null; // this reminder was already sent
    throw err;
  }
  await notifyUsers([student], { title: MESSAGE_TITLE[kind] || 'Library', message: text, type: 'library', link: '/my-library' });
  const status = 'in_app'; // no SMS any more: the student is told through the in-app notification above (the bell in the top bar)
  await LibraryMessage.updateOne({ _id: log._id }, { status });
  return { status, id: log._id };
};

// ---------------------------------------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------------------------------------
export const recountBook = async (bookId) => {
  const rows = await BookCopy.aggregate([{ $match: { book: oid(bookId) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const c = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const total = rows.filter((r) => r._id !== CS.WITHDRAWN).reduce((s, r) => s + r.n, 0);
  await Book.updateOne({ _id: bookId }, {
    copiesTotal: total, copiesAvailable: c[CS.AVAILABLE] || 0, copiesIssued: c[CS.ISSUED] || 0,
    copiesReserved: c[CS.RESERVED] || 0, copiesLost: c[CS.LOST] || 0, copiesDamaged: c[CS.DAMAGED] || 0,
  });
};

export const bookView = (b, staff = false) => ({
  _id: b._id, bookId: b.bookId, title: b.title, authors: b.authors || [], isbn: b.isbn, category: b.category, publisher: b.publisher, edition: b.edition, year: b.year,
  language: b.language, pages: b.pages, shelf: b.shelf, description: b.description, department: b.department || null, semesterNumber: b.semesterNumber ?? null,
  copiesTotal: b.copiesTotal, copiesAvailable: b.copiesAvailable, available: b.copiesAvailable > 0, status: b.status,
  ...(staff ? { price: b.price, copiesIssued: b.copiesIssued, copiesReserved: b.copiesReserved, copiesLost: b.copiesLost, copiesDamaged: b.copiesDamaged } : {}),
});

export const buildBookFilter = ({ q, category, available, semester, includeRemoved = false } = {}) => {
  const f = {};
  if (!includeRemoved) f.status = 'active';
  if (category) f.category = category;
  if (semester) f.semesterNumber = Number(semester);
  if (available === 'true' || available === true) f.copiesAvailable = { $gt: 0 };
  const term = String(q || '').trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    f.$or = [{ title: rx }, { authors: rx }, { isbn: rx }, { bookId: rx }, { category: rx }, { publisher: rx }];
  }
  return f;
};

export const addCopies = async (book, count, actor, note = '') => {
  const existing = await BookCopy.find({ book: book._id }).select('code').lean();
  let n = existing.reduce((m, c) => Math.max(m, parseInt(c.code.slice(book.bookId.length + 1), 10) || 0), 0);
  const docs = Array.from({ length: count }, () => ({ book: book._id, code: makeCopyCode(book.bookId, (n += 1)), addedBy: actor?._id, note }));
  try {
    await BookCopy.insertMany(docs);
  } catch (err) {
    if (err.code === 11000 || err.writeErrors) throw ApiError.conflict('A copy code of this book is already used by another book. Choose a different Book ID');
    throw err;
  }
  await recountBook(book._id);
  return docs.map((d) => d.code);
};

const ensureCategory = async (name) => {
  if (!name) return;
  await LibraryRules.updateOne({ key: 'global' }, { $addToSet: { categories: name } }, { upsert: true });
};

export const MAX_BOOKS_PER_SEMESTER = 30;
// The library keeps up to 30 titles for each semester (a title counts once, however many copies it has).
const assertSemesterRoom = async (semesterNumber, exceptId = null) => {
  if (!semesterNumber) return;
  const used = await Book.countDocuments({ status: 'active', semesterNumber, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (used >= MAX_BOOKS_PER_SEMESTER) throw ApiError.conflict(`Semester ${semesterNumber} already has ${used} books. The limit is ${MAX_BOOKS_PER_SEMESTER} per semester`);
};

export const createBook = async (data, actor) => {
  const { copies = 1, ...fields } = data;
  await assertSemesterRoom(fields.semesterNumber);
  const bookId = fields.bookId || makeBookId(await Counter.next('library_book'));
  let book;
  try {
    book = await Book.create({ ...fields, bookId, createdBy: actor._id });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(`The Book ID ${bookId} already exists`);
    throw err;
  }
  await ensureCategory(book.category);
  await addCopies(book, copies, actor);
  libLog(actor, 'book.add', 'Book', book._id, { title: book.title, bookId, copies });
  return Book.findById(book._id);
};

export const updateBook = async (book, data, actor) => {
  const { bookId: _ignored, copies: _copies, ...fields } = data; // the Book ID is printed on every copy, so it never changes
  if (fields.semesterNumber && fields.semesterNumber !== book.semesterNumber) await assertSemesterRoom(fields.semesterNumber, book._id);
  book.set(fields);
  await book.save();
  await ensureCategory(book.category);
  libLog(actor, 'book.update', 'Book', book._id, { title: book.title, fields: Object.keys(fields) });
  return book;
};

// A title with copies that are out (or held for a student) cannot be removed. Otherwise the title leaves the catalogue, its copies are withdrawn,
// and the history (loans, fines) stays.
export const removeBook = async (book, actor) => {
  const busy = await BookCopy.countDocuments({ book: book._id, status: { $in: [CS.ISSUED, CS.RESERVED] } });
  if (busy) throw ApiError.conflict(`${busy} cop${busy === 1 ? 'y is' : 'ies are'} still issued or held for a student. Get them back first`);
  await BookCopy.updateMany({ book: book._id }, { status: CS.WITHDRAWN, statusChangedAt: new Date(), currentLoan: null, heldFor: null });
  await LibraryReservation.updateMany({ book: book._id, status: RS.WAITING }, { status: RS.CANCELLED, note: 'The book was removed from the library' });
  book.status = 'removed';
  await book.save();
  await recountBook(book._id);
  libLog(actor, 'book.remove', 'Book', book._id, { title: book.title });
};

const COPY_MOVES = {
  [CS.AVAILABLE]: [CS.DAMAGED, CS.LOST, CS.WITHDRAWN],
  [CS.DAMAGED]: [CS.AVAILABLE, CS.LOST, CS.WITHDRAWN],
  [CS.LOST]: [CS.AVAILABLE, CS.WITHDRAWN],
  [CS.WITHDRAWN]: [CS.AVAILABLE],
};
// Inventory: mark a copy that is NOT out as damaged, lost (missing from the shelf), found/repaired (available again) or withdrawn.
export const setCopyStatus = async (copy, status, note, actor) => {
  if ([CS.ISSUED, CS.RESERVED].includes(copy.status)) throw ApiError.conflict(copy.status === CS.ISSUED ? 'This copy is issued. Return it first (or record it as lost from the loan)' : 'This copy is held for a student. Cancel the reservation first');
  if (!(COPY_MOVES[copy.status] || []).includes(status)) throw ApiError.badRequest(`A ${copy.status} copy cannot become ${status}`);
  const book = await Book.findById(copy.book);
  if (book?.status === 'removed' && status === CS.AVAILABLE) throw ApiError.badRequest('The book was removed from the library');
  const before = copy.status;
  copy.status = status;
  copy.statusChangedAt = new Date();
  if (note !== undefined) copy.note = note;
  await copy.save();
  await recountBook(copy.book);
  if (status === CS.AVAILABLE) await promoteReservation(copy.book);
  libLog(actor, 'copy.status', 'BookCopy', copy._id, { code: copy.code, from: before, to: status, note });
  return copy;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------------------------------------------------------
export const findStudent = async (ident) => {
  const s = String(ident || '').trim();
  if (!s) throw ApiError.badRequest('Enter the student roll number');
  const profile = HEX24.test(s)
    ? await StudentProfile.findOne({ $or: [{ user: s }, { _id: s }] })
    : await StudentProfile.findOne({ rollNumber: s.toUpperCase() });
  if (!profile) throw ApiError.notFound(`No student found for "${s}". Check the roll number`);
  const user = await User.findById(profile.user).select('name email phone isActive role');
  if (!user || user.role !== ROLES.STUDENT) throw ApiError.notFound('Student not found');
  return { profile, user };
};

// ---------------------------------------------------------------------------------------------------------------------------
// Loans: how one loan looks today (late fine, balance, state)
// ---------------------------------------------------------------------------------------------------------------------------
export const loanState = (loan, todayKey) => {
  const open = loan.status === LS.ISSUED;
  const fineCfg = { dueDay: loan.dueDay, perDay: loan.fine?.perDay || 0, cap: loan.fine?.cap ?? null, grace: loan.fine?.grace || 0 };
  const endDay = open ? todayKey : loan.returnedDay || todayKey;
  const calc = calcFine({ ...fineCfg, endDay });
  const fineAmount = open ? calc.amount : loan.fine?.accrued || 0;
  const bal = loanBalance({ fineAccrued: fineAmount, penalties: loan.penalties || [], payments: loan.payments || [] });
  const daysLeft = open ? diffDays(loan.dueDay, todayKey) : null;
  const state = open ? (daysLeft < 0 ? 'overdue' : daysLeft <= 2 ? 'due_soon' : 'issued') : loan.status;
  return { open, daysLeft, overdueDays: calc.overdueDays, state, ...bal };
};

const book$ = 'title authors bookId category';
export const loanView = (loan, todayKey) => {
  const s = loanState(loan, todayKey);
  return {
    _id: loan._id,
    book: loan.book ? { _id: loan.book._id || loan.book, title: loan.book.title, authors: loan.book.authors, bookId: loan.book.bookId, category: loan.book.category } : null,
    copyCode: loan.copy?.code || '',
    student: loan.student ? { _id: loan.student._id || loan.student, name: loan.student.name } : null,
    rollNumber: loan.rollNumber,
    issuedDay: loan.issuedDay, dueDay: loan.dueDay, originalDueDay: loan.originalDueDay, returnedDay: loan.returnedDay || null, renewals: loan.renewals,
    status: loan.status, state: s.state, daysLeft: s.daysLeft, overdueDays: s.overdueDays,
    fine: s.fine, penalty: s.penalty, charged: s.charged, paid: s.paid, waived: s.waived, pending: s.pending,
    returnCondition: loan.returnCondition, note: loan.note, complaint: !!loan.complaint, principalComplaint: !!loan.principalComplaint,
    penalties: (loan.penalties || []).map((p) => ({ type: p.type, amount: p.amount, note: p.note, at: p.at })),
    payments: (loan.payments || []).map((p) => ({ kind: p.kind, amount: p.amount, note: p.note, at: p.at })),
  };
};

export const withLoanRefs = (q) => q.populate('book', book$).populate('copy', 'code').populate('student', 'name');

// What one student owes and holds right now.
export const studentTotals = (loans, todayKey) => {
  let active = 0, overdue = 0, pending = 0, paid = 0, lost = 0, returned = 0;
  for (const l of loans) {
    const s = loanState(l, todayKey);
    if (s.open) { active += 1; if (s.state === 'overdue') overdue += 1; }
    if (l.status === LS.LOST) lost += 1;
    if (l.status === LS.RETURNED) returned += 1;
    pending += s.pending;
    paid += s.paid;
  }
  return { active, overdue, pending: Math.round(pending * 100) / 100, paid: Math.round(paid * 100) / 100, lost, returned, total: loans.length };
};

// ---------------------------------------------------------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------------------------------------------------------
const resolveCopyForIssue = async (rawCode, studentId) => {
  const code = normalizeCode(rawCode);
  if (!code) throw ApiError.badRequest('Scan or type the book copy code');
  let copy = await BookCopy.findOne({ code });
  if (!copy) {
    // The librarian may scan the title's Book ID or ISBN instead of a copy: take a copy that is free (or held for this very student).
    const book = await Book.findOne({ $or: [{ bookId: code }, { isbn: code }], status: 'active' });
    if (!book) throw ApiError.notFound(`No book copy with the code "${code}"`);
    const mine = await LibraryReservation.findOne({ book: book._id, student: studentId, status: RS.READY });
    copy = (mine?.copy && (await BookCopy.findOne({ _id: mine.copy, status: CS.RESERVED }))) || (await BookCopy.findOne({ book: book._id, status: CS.AVAILABLE }).sort({ code: 1 }));
    if (!copy) throw ApiError.conflict(`"${book.title}" has no free copy right now. The student can reserve it`);
  }
  return copy;
};

export const issueBook = async ({ student: ident, code, issuer, days, ip = '' }) => {
  const rules = await LibraryRules.getRules();
  const today = await libraryToday();
  const { profile, user } = await findStudent(ident);
  if (!user.isActive || profile.status !== 'active') throw ApiError.forbidden(`This student is ${user.isActive ? profile.status : 'inactive'}. Books cannot be issued`);

  const copy = await resolveCopyForIssue(code, profile.user);
  const book = await Book.findById(copy.book);
  if (!book || book.status !== 'active') throw ApiError.badRequest('This book was removed from the library');

  // The state of this copy: free, or held for this student, or something else.
  let reservation = null;
  if (copy.status === CS.RESERVED) {
    reservation = copy.heldFor ? await LibraryReservation.findById(copy.heldFor) : null;
    if (!reservation || String(reservation.student) !== String(profile.user)) throw ApiError.conflict('This copy is being held for another student who reserved it');
  } else if (copy.status !== CS.AVAILABLE) {
    throw ApiError.conflict(`This copy is ${copy.status} and cannot be issued`);
  }

  // The rules for the student.
  const open = await LibraryLoan.find({ student: profile.user, status: LS.ISSUED }).select('book dueDay fine').lean();
  if (open.some((l) => String(l.book) === String(book._id))) throw ApiError.conflict('This student already has a copy of this book');
  if (open.length >= rules.maxBooksPerStudent) throw ApiError.conflict(`This student already has ${open.length} book(s). The limit is ${rules.maxBooksPerStudent}`);
  if (rules.blockIssueIfOverdue && open.some((l) => l.dueDay < today)) throw ApiError.conflict('This student has an overdue book. It must be returned before a new book is issued');
  if (rules.blockIssueIfFineUnpaid) {
    const all = await LibraryLoan.find({ student: profile.user }).lean();
    if (studentTotals(all, today).pending > 0) throw ApiError.conflict('This student has an unpaid library fine. It must be paid before a new book is issued');
  }

  // Take the copy. The condition makes sure nobody else took it a moment ago.
  const taken = await BookCopy.findOneAndUpdate({ _id: copy._id, status: copy.status }, { status: CS.ISSUED, heldFor: null, statusChangedAt: new Date() }, { new: true });
  if (!taken) throw ApiError.conflict('This copy was just issued by someone else');

  let loan;
  try {
    const dueDay = dueDayFrom(today, days || rules.loanDays);
    loan = await LibraryLoan.create({
      book: book._id, copy: copy._id, student: profile.user, rollNumber: profile.rollNumber, department: profile.department,
      issuedDay: today, dueDay, originalDueDay: dueDay, issuedBy: issuer._id,
      fine: { perDay: rules.finePerDay, cap: rules.maxFinePerBook, grace: rules.graceDays },
    });
  } catch (err) {
    await BookCopy.updateOne({ _id: copy._id }, { status: copy.status, heldFor: copy.heldFor || null });
    throw err.code === 11000 ? ApiError.conflict('This copy was just issued by someone else') : err;
  }
  await BookCopy.updateOne({ _id: copy._id }, { currentLoan: loan._id });

  // Any reservation of this student for this title is now done. A copy that was held for them but not the one they took goes back on the shelf.
  const mine = await LibraryReservation.find({ book: book._id, student: profile.user, status: { $in: [RS.WAITING, RS.READY] } });
  for (const r of mine) {
    if (r.copy && String(r.copy) !== String(copy._id)) {
      await BookCopy.updateOne({ _id: r.copy, status: CS.RESERVED }, { status: CS.AVAILABLE, heldFor: null, statusChangedAt: new Date() });
    }
    r.status = RS.FULFILLED; r.fulfilledAt = new Date(); r.loan = loan._id;
    await r.save();
  }
  await recountBook(book._id);
  if (mine.some((r) => r.copy && String(r.copy) !== String(copy._id))) await promoteReservation(book._id);

  const currency = await getCurrency();
  await sendLibraryMessage({ loan, student: profile.user, kind: 'issued', text: smsText.issued({ title: book.title, issuedDay: today, dueDay: loan.dueDay, currency, perDay: rules.finePerDay }), rules });
  libLog(issuer, 'issue', 'LibraryLoan', loan._id, { student: user.name, roll: profile.rollNumber, book: book.title, copy: copy.code, dueDay: loan.dueDay }, ip);
  return { loan, book, student: { name: user.name, rollNumber: profile.rollNumber } };
};

// ---------------------------------------------------------------------------------------------------------------------------
// Return, renew, lost
// ---------------------------------------------------------------------------------------------------------------------------
const openLoanFor = async ({ code, loanId }) => {
  if (loanId) {
    const loan = await LibraryLoan.findOne({ _id: loanId, status: LS.ISSUED });
    if (!loan) throw ApiError.notFound('This loan is not open (the book may already be returned)');
    return loan;
  }
  const c = normalizeCode(code);
  if (!c) throw ApiError.badRequest('Scan or type the book copy code');
  const copy = await BookCopy.findOne({ code: c });
  if (!copy) throw ApiError.notFound(`No book copy with the code "${c}"`);
  const loan = await LibraryLoan.findOne({ copy: copy._id, status: LS.ISSUED });
  if (!loan) throw ApiError.conflict(`This copy is not issued to anyone (status: ${copy.status})`);
  return loan;
};

const closeLibraryComplaints = async (loan, text) => {
  const list = await Complaint.find({ libraryLoan: loan._id, status: { $in: ['open', 'in_review'] } });
  for (const c of list) {
    c.responses.push({ byRole: 'library', message: text, status: 'resolved' });
    c.status = 'resolved';
    c.resolution = text;
    c.resolvedAt = new Date();
    await c.save();
  }
};

export const returnBook = async ({ code, loanId, condition = 'good', damageFee = 0, note = '', receiver, ip = '' }) => {
  const today = await libraryToday();
  const loan = await openLoanFor({ code, loanId });
  const fine = calcFine({ dueDay: loan.dueDay, endDay: today, perDay: loan.fine?.perDay, cap: loan.fine?.cap ?? null, grace: loan.fine?.grace });
  const set = { status: LS.RETURNED, returnedAt: new Date(), returnedDay: today, receivedBy: receiver._id, returnCondition: condition, 'fine.accrued': fine.amount };
  if (note) set.note = note;
  const update = { $set: set };
  if (condition === 'damaged' && damageFee > 0) update.$push = { penalties: { type: 'damaged', amount: damageFee, note: note || 'Damaged when returned', by: receiver._id } };
  // Only the first of two simultaneous returns succeeds.
  const done = await LibraryLoan.findOneAndUpdate({ _id: loan._id, status: LS.ISSUED }, update, { new: true });
  if (!done) throw ApiError.conflict('This book was just returned by someone else');

  await BookCopy.updateOne({ _id: loan.copy }, { status: condition === 'damaged' ? CS.DAMAGED : CS.AVAILABLE, currentLoan: null, statusChangedAt: new Date(), ...(condition === 'damaged' ? { note: note || 'Damaged when returned' } : {}) });
  await recountBook(loan.book);
  if (condition !== 'damaged') await promoteReservation(loan.book);
  await closeLibraryComplaints(done, `The book was returned on ${today}.`);

  const book = await Book.findById(loan.book).select('title');
  const bal = loanBalance({ fineAccrued: done.fine.accrued, penalties: done.penalties, payments: done.payments });
  const currency = await getCurrency();
  await sendLibraryMessage({ loan: done, student: loan.student, kind: 'returned', text: smsText.returned({ title: book?.title, returnedDay: today, pending: bal.pending, currency }) });
  libLog(receiver, 'return', 'LibraryLoan', loan._id, { book: book?.title, roll: loan.rollNumber, condition, fine: fine.amount, overdueDays: fine.overdueDays }, ip);
  return { loan: done, fine: fine.amount, overdueDays: fine.overdueDays, pending: bal.pending, book };
};

export const renewLoan = async ({ loanId, actor, isStudent = false, ip = '' }) => {
  const rules = await LibraryRules.getRules();
  const today = await libraryToday();
  const loan = await LibraryLoan.findOne({ _id: loanId, status: LS.ISSUED });
  if (!loan || (isStudent && String(loan.student) !== String(actor._id))) throw ApiError.notFound('Loan not found');
  if (rules.maxRenewals <= 0) throw ApiError.badRequest('Books cannot be renewed');
  if (loan.renewals >= rules.maxRenewals) throw ApiError.badRequest(`This book was already renewed ${loan.renewals} time(s). The limit is ${rules.maxRenewals}`);
  if (loan.dueDay < today) throw ApiError.badRequest('An overdue book cannot be renewed. Return it first');
  if (await LibraryReservation.exists({ book: loan.book, status: RS.WAITING })) throw ApiError.conflict('Another student is waiting for this book, so it cannot be renewed');
  const dueDay = addDays(loan.dueDay, rules.renewDays);
  const done = await LibraryLoan.findOneAndUpdate({ _id: loan._id, status: LS.ISSUED, renewals: loan.renewals }, { dueDay, $inc: { renewals: 1 } }, { new: true });
  if (!done) throw ApiError.conflict('The loan changed. Please try again');
  const book = await Book.findById(loan.book).select('title');
  await notifyUsers([loan.student], { title: 'Library: book renewed', message: `"${book?.title}" is now due on ${dueDay}.`, type: 'library', link: '/my-library' });
  libLog(actor, 'renew', 'LibraryLoan', loan._id, { book: book?.title, roll: loan.rollNumber, dueDay }, ip);
  return done;
};

// The student lost the book. The late fine stops today and the price of the book is charged (the librarian can change the amount).
export const markLost = async ({ loanId, amount, note = '', actor, ip = '' }) => {
  const rules = await LibraryRules.getRules();
  const today = await libraryToday();
  const loan = await LibraryLoan.findOne({ _id: loanId, status: LS.ISSUED });
  if (!loan) throw ApiError.notFound('This loan is not open');
  const book = await Book.findById(loan.book);
  const fine = calcFine({ dueDay: loan.dueDay, endDay: today, perDay: loan.fine?.perDay, cap: loan.fine?.cap ?? null, grace: loan.fine?.grace });
  const price = amount ?? lostPenalty({ price: book?.price || 0, multiplier: rules.lostPenaltyMultiplier, processingFee: rules.lostProcessingFee });
  const set = { status: LS.LOST, returnCondition: 'lost', returnedDay: today, 'fine.accrued': fine.amount }; // for a lost book "returnedDay" is the day it was recorded lost
  if (note) set.note = note;
  const done = await LibraryLoan.findOneAndUpdate({ _id: loan._id, status: LS.ISSUED }, { $set: set, $push: { penalties: { type: 'lost', amount: price, note: note || 'Lost by the student', by: actor._id } } }, { new: true });
  if (!done) throw ApiError.conflict('The loan changed. Please try again');
  await BookCopy.updateOne({ _id: loan.copy }, { status: CS.LOST, currentLoan: null, statusChangedAt: new Date(), note: `Lost by ${loan.rollNumber}` });
  await recountBook(loan.book);

  const bal = loanBalance({ fineAccrued: done.fine.accrued, penalties: done.penalties, payments: done.payments });
  const currency = await getCurrency();
  await sendLibraryMessage({ loan: done, student: loan.student, kind: 'lost', text: smsText.lost({ title: book?.title, pending: bal.pending, currency }) });
  await fileComplaint(done, 'lost');
  await notifyUsers(await principalIds(), {
    title: 'Library: a book was lost', message: `${loan.rollNumber} lost "${book?.title}". Amount charged: ${currency} ${bal.charged}.`, type: 'library', link: '/library',
  });
  libLog(actor, 'lost', 'LibraryLoan', loan._id, { book: book?.title, roll: loan.rollNumber, charged: bal.charged }, ip);
  return { loan: done, charged: bal.charged };
};

// Money received at the desk, or an amount the librarian forgives. The loan must be closed first (the fine of an open loan is still growing).
export const recordPayment = async ({ loanId, kind, amount, note = '', actor, ip = '' }) => {
  const today = await libraryToday();
  const loan = await LibraryLoan.findById(loanId);
  if (!loan) throw ApiError.notFound('Loan not found');
  if (loan.status === LS.ISSUED) throw ApiError.badRequest('The book is still out, so the fine is still growing. Return the book first, then record the payment');
  const bal = loanState(loan, today);
  if (bal.pending <= 0) throw ApiError.badRequest('Nothing is left to pay on this loan');
  if (amount > bal.pending + 0.001) throw ApiError.badRequest(`Only ${bal.pending} is left to pay on this loan`);
  loan.payments.push({ kind, amount, note, by: actor._id });
  await loan.save();
  const after = loanState(loan, today);
  if (kind === 'payment') {
    const book = await Book.findById(loan.book).select('title');
    const currency = await getCurrency();
    await sendLibraryMessage({ loan, student: loan.student, kind: 'fine', key: String(loan.payments.length), text: smsText.fine({ title: book?.title, amount, pending: after.pending, currency }) });
  }
  libLog(actor, kind === 'payment' ? 'fine.pay' : 'fine.waive', 'LibraryLoan', loan._id, { roll: loan.rollNumber, amount, pending: after.pending, note }, ip);
  return { loan, pending: after.pending };
};

// ---------------------------------------------------------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------------------------------------------------------
export const reserveBook = async ({ bookId, user }) => {
  const rules = await LibraryRules.getRules();
  const profile = await StudentProfile.findOne({ user: user._id });
  if (!profile || profile.status !== 'active') throw ApiError.forbidden('Only active students can reserve books');
  const book = await Book.findOne({ _id: bookId, status: 'active' });
  if (!book) throw ApiError.notFound('Book not found');
  if (book.copiesAvailable > 0) throw ApiError.conflict('A copy of this book is available now. Please borrow it at the library desk');
  if (!book.copiesTotal) throw ApiError.conflict('This book has no copies in the library');
  if (await LibraryLoan.exists({ student: user._id, book: book._id, status: LS.ISSUED })) throw ApiError.conflict('You already have this book');
  const openCount = await LibraryReservation.countDocuments({ student: user._id, status: { $in: [RS.WAITING, RS.READY] } });
  if (openCount >= rules.maxReservationsPerStudent) throw ApiError.conflict(`You can reserve at most ${rules.maxReservationsPerStudent} books at a time`);
  let r;
  try {
    r = await LibraryReservation.create({ book: book._id, student: user._id, rollNumber: profile.rollNumber });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('You are already in the waiting list for this book');
    throw err;
  }
  const position = await LibraryReservation.countDocuments({ book: book._id, status: RS.WAITING, createdAt: { $lte: r.createdAt } });
  libLog(user, 'reserve', 'LibraryReservation', r._id, { book: book.title, roll: profile.rollNumber, position });
  return { reservation: r, position, book };
};

// A copy became free: the first student waiting for the title gets it (held at the desk).
export const promoteReservation = async (bookId) => {
  const rules = await LibraryRules.getRules();
  for (let guard = 0; guard < 20; guard += 1) { // skips students who are no longer active
    const next = await LibraryReservation.findOne({ book: bookId, status: RS.WAITING }).sort({ createdAt: 1 });
    if (!next) return null;
    const student = await User.findById(next.student).select('isActive');
    if (!student?.isActive) { await LibraryReservation.updateOne({ _id: next._id }, { status: RS.CANCELLED, note: 'The student account is not active' }); continue; }
    const copy = await BookCopy.findOneAndUpdate({ book: bookId, status: CS.AVAILABLE }, { status: CS.RESERVED, heldFor: next._id, statusChangedAt: new Date() }, { new: true, sort: { code: 1 } });
    if (!copy) return null; // no free copy
    const holdUntilDay = addDays(await libraryToday(), rules.reservationHoldDays);
    const ready = await LibraryReservation.findOneAndUpdate({ _id: next._id, status: RS.WAITING }, { status: RS.READY, copy: copy._id, readyAt: new Date(), holdUntilDay }, { new: true });
    if (!ready) { await BookCopy.updateOne({ _id: copy._id }, { status: CS.AVAILABLE, heldFor: null }); continue; }
    await recountBook(bookId);
    const book = await Book.findById(bookId).select('title');
    await sendLibraryMessage({ student: next.student, kind: 'reservation_ready', text: smsText.reservation_ready({ title: book?.title, holdUntilDay }), rules });
    libLog(null, 'reservation.ready', 'LibraryReservation', next._id, { book: book?.title, roll: next.rollNumber, holdUntilDay });
    return ready;
  }
  return null;
};

const releaseReservation = async (r, status, note = '', actor = null) => {
  const copyId = r.copy;
  r.status = status;
  r.note = note || r.note;
  if (actor) r.cancelledBy = actor._id;
  await r.save();
  if (copyId) {
    await BookCopy.updateOne({ _id: copyId, status: CS.RESERVED }, { status: CS.AVAILABLE, heldFor: null, statusChangedAt: new Date() });
    await recountBook(r.book);
    await promoteReservation(r.book);
  }
};

export const cancelReservation = async ({ id, actor, isStudent = false }) => {
  const r = await LibraryReservation.findOne({ _id: id, status: { $in: [RS.WAITING, RS.READY] } });
  if (!r || (isStudent && String(r.student) !== String(actor._id))) throw ApiError.notFound('Reservation not found');
  await releaseReservation(r, RS.CANCELLED, isStudent ? 'Cancelled by the student' : 'Cancelled by the library', actor);
  libLog(actor, 'reservation.cancel', 'LibraryReservation', r._id, { roll: r.rollNumber });
  return r;
};

export const expireReservations = async (today, rules) => {
  const due = await LibraryReservation.find({ status: RS.READY, holdUntilDay: { $lt: today } }).limit(200);
  for (const r of due) {
    const claimed = await LibraryReservation.findOne({ _id: r._id, status: RS.READY });
    if (!claimed) continue;
    const book = await Book.findById(r.book).select('title');
    await releaseReservation(claimed, RS.EXPIRED, 'Not collected in time');
    await sendLibraryMessage({ student: r.student, kind: 'reservation_expired', text: smsText.reservation_expired({ title: book?.title }), rules });
    libLog(null, 'reservation.expire', 'LibraryReservation', r._id, { book: book?.title, roll: r.rollNumber });
  }
  return due.length;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Complaints to the student's department (HOD) and the principal
// ---------------------------------------------------------------------------------------------------------------------------
// kind: 'overdue' -> department complaint (after N days late) | 'principal' -> escalation to the principal | 'lost' -> department complaint for a lost book
export const fileComplaint = async (loanDoc, kind) => {
  const toPrincipal = kind === 'principal';
  const claimField = toPrincipal ? 'principalClaimed' : 'complaintClaimed';
  const target = toPrincipal ? 'principalComplaint' : 'complaint';
  // Claim first (atomic), so two runs of the job can never file two complaints for the same loan.
  const loan = await LibraryLoan.findOneAndUpdate({ _id: loanDoc._id, [claimField]: false, status: { $in: [LS.ISSUED, LS.LOST] } }, { [claimField]: true }, { new: true });
  if (!loan) return null;
  try {
    const today = await libraryToday();
    const [book, copy, user, profile, currency] = await Promise.all([
      Book.findById(loan.book).select('title authors bookId'),
      BookCopy.findById(loan.copy).select('code'),
      User.findById(loan.student).select('name phone email'),
      StudentProfile.findOne({ user: loan.student }).populate('department', 'name code hod').populate('semester', 'name'),
      getCurrency(),
    ]);
    const s = loanState(loan, today);
    const dept = profile?.department;
    const lines = [
      'This complaint was filed automatically by the library.',
      '',
      `Student: ${user?.name} (${loan.rollNumber})`,
      `Department: ${dept?.name || '-'}${profile?.semester ? ` · ${profile.semester.name}` : ''}`,
      `Phone: ${user?.phone || 'not on file'} · Email: ${user?.email || '-'}`,
      '',
      `Book: "${book?.title}" by ${authorsText(book)}`,
      `Book ID: ${book?.bookId} · Copy: ${copy?.code}`,
      `Issued on: ${loan.issuedDay} · Return deadline: ${loan.dueDay}`,
      kind === 'lost' ? `The student reported the book as LOST on ${loan.returnedDay}.` : `The book is ${s.overdueDays} day(s) overdue.`,
      `Charges so far: ${currency} ${s.charged} (late fine ${currency} ${s.fine}${s.penalty ? `, lost / damaged charge ${currency} ${s.penalty}` : ''}).`,
      '',
      kind === 'lost' ? 'Please ask the student to settle the amount at the library.' : 'Please ask the student to return the book to the library. This complaint closes by itself when the book is returned.',
    ];
    const category = kind === 'lost' ? 'library_lost' : 'library_overdue';
    const c = await Complaint.create({
      student: loan.student,
      department: loan.department || dept?._id,
      category,
      recipient: toPrincipal ? 'university_head' : 'hod',
      subject: `${toPrincipal ? 'Escalation: ' : ''}${kind === 'lost' ? 'Lost library book' : 'Library book not returned'}: ${book?.title} (${loan.rollNumber})`.slice(0, 200),
      description: lines.join('\n'),
      source: 'library',
      libraryLoan: loan._id,
    });
    await LibraryLoan.updateOne({ _id: loan._id }, { [target]: c._id });
    const handlers = toPrincipal ? await principalIds() : dept?.hod ? [dept.hod] : [];
    await notifyUsers(handlers, {
      title: toPrincipal ? 'Library: a book is very late' : kind === 'lost' ? 'Library: a student lost a book' : 'Library: a student did not return a book',
      message: `${user?.name} (${loan.rollNumber}): "${book?.title}". Open the complaint.`, type: 'complaint', link: '/complaints',
    });
    libLog(null, toPrincipal ? 'complaint.principal' : 'complaint.department', 'Complaint', c._id, { roll: loan.rollNumber, book: book?.title, overdueDays: s.overdueDays, category });
    return c;
  } catch (err) {
    await LibraryLoan.updateOne({ _id: loan._id }, { [claimField]: false }); // nothing was filed: let the next run try again
    console.error('Library complaint failed:', err.message);
    return null;
  }
};

// ---------------------------------------------------------------------------------------------------------------------------
// The automatic job: expire held reservations, send the reminders, detect students who did not return a book, file complaints.
// Runs from the server timer, from Vercel Cron, when the librarian opens the dashboard, or by the "Run now" button.
// Safe to run as often as you like (see the notes on atomic claims at the top of this file).
// ---------------------------------------------------------------------------------------------------------------------------
let running = false;
let lastRun = 0;
export const runLibraryJobs = async ({ force = false } = {}) => {
  if (running) return { skipped: 'already running' };
  if (!force && Date.now() - lastRun < 10 * 60 * 1000) return { skipped: 'ran a few minutes ago' };
  running = true;
  lastRun = Date.now();
  const out = { expiredReservations: 0, reminders: 0, newlyOverdue: 0, complaints: 0, principalComplaints: 0, checked: 0 };
  try {
    const [rules, today, currency] = await Promise.all([LibraryRules.getRules(), libraryToday(), getCurrency()]);
    out.expiredReservations = await expireReservations(today, rules);

    const horizon = addDays(today, Math.max(0, ...(rules.reminderBeforeDays || [0])));
    const loans = await LibraryLoan.find({ status: LS.ISSUED, dueDay: { $lte: horizon } }).sort({ dueDay: 1 }).limit(1000).populate('student', 'name isActive').populate('book', 'title');
    const controllers = await controllerIds();
    for (const loan of loans) {
      out.checked += 1;
      const student = loan.student;
      const title = loan.book?.title;
      const state = loanState(loan, today);

      // 1. Reminders (stop by themselves: a returned loan is no longer in this list).
      const d = reminderDecision({ dueDay: loan.dueDay, issuedDay: loan.issuedDay, todayKey: today, rules });
      if (d && student?.isActive) {
        const text = smsText[d.kind]({ title, dueDay: loan.dueDay, daysLeft: d.daysLeft, overdueDays: d.overdueDays || state.overdueDays, fine: state.fine, currency });
        if (await sendLibraryMessage({ loan, student: student._id, kind: d.kind, key: d.key, text, rules })) out.reminders += 1;
      }

      if (state.state !== 'overdue') continue;

      // 2. The librarian is told once about every newly overdue book.
      const first = await LibraryLoan.findOneAndUpdate({ _id: loan._id, overdueNotified: false }, { overdueNotified: true });
      if (first) {
        out.newlyOverdue += 1;
        await notifyUsers(controllers, { title: 'Library: a book is overdue', message: `${student?.name} (${loan.rollNumber}) has not returned "${title}" (due ${loan.dueDay}).`, type: 'library', link: '/library' });
        libLog(null, 'overdue.detected', 'LibraryLoan', loan._id, { roll: loan.rollNumber, book: title, dueDay: loan.dueDay });
      }

      // 3. Complaint to the department, and later the principal.
      const stage = escalationStage({ overdueDays: state.overdueDays, rules });
      if (stage.department && !loan.complaintClaimed && (await fileComplaint(loan, 'overdue'))) out.complaints += 1;
      if (stage.principal && !loan.principalClaimed && (await fileComplaint(loan, 'principal'))) out.principalComplaints += 1;
    }
    return out;
  } finally {
    running = false;
  }
};

// ---------------------------------------------------------------------------------------------------------------------------
// Listing helpers
// ---------------------------------------------------------------------------------------------------------------------------
export const searchStudents = async ({ q, holding }) => {
  const today = await libraryToday();
  let profiles;
  if (holding) {
    const ids = await LibraryLoan.find({ status: LS.ISSUED }).distinct('student');
    profiles = await StudentProfile.find({ user: { $in: ids } }).limit(300).populate('department', 'name code').populate('semester', 'name').populate('user', 'name phone isActive');
  } else {
    const term = String(q || '').trim();
    if (term.length < 2) return [];
    const rx = new RegExp(escapeRegex(term), 'i');
    const userIds = await User.find({ role: ROLES.STUDENT, name: rx }).limit(30).distinct('_id');
    profiles = await StudentProfile.find({ $or: [{ rollNumber: rx }, { user: { $in: userIds } }] }).limit(20).populate('department', 'name code').populate('semester', 'name').populate('user', 'name phone isActive');
  }
  const loans = await LibraryLoan.find({ student: { $in: profiles.map((p) => p.user?._id) } }).lean();
  const byStudent = new Map();
  for (const l of loans) byStudent.set(String(l.student), [...(byStudent.get(String(l.student)) || []), l]);
  const rows = profiles.filter((p) => p.user).map((p) => ({
    _id: p.user._id, name: p.user.name, rollNumber: p.rollNumber, department: p.department ? { name: p.department.name, code: p.department.code } : null,
    semester: p.semester?.name || '', status: p.status, active: p.user.isActive, hasPhone: !!p.user.phone, phone: maskPhone(p.user.phone),
    ...studentTotals(byStudent.get(String(p.user._id)) || [], today),
  }));
  return holding ? rows.sort((a, b) => b.overdue - a.overdue || b.active - a.active || a.rollNumber.localeCompare(b.rollNumber)) : rows.sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));
};

export const studentHistory = async (studentId) => {
  const today = await libraryToday();
  const { profile, user } = await findStudent(studentId);
  const loans = await withLoanRefs(LibraryLoan.find({ student: user._id }).sort({ issuedAt: -1 }).limit(500)).lean();
  const reservations = await LibraryReservation.find({ student: user._id }).sort({ createdAt: -1 }).limit(50).populate('book', 'title bookId').lean();
  const full = await profile.populate([{ path: 'department', select: 'name code' }, { path: 'semester', select: 'name' }]);
  return {
    student: { _id: user._id, name: user.name, email: user.email, phone: maskPhone(user.phone), hasPhone: !!user.phone, rollNumber: profile.rollNumber, department: full.department, semester: full.semester?.name || '', section: profile.section, status: profile.status },
    totals: studentTotals(loans, today),
    loans: loans.map((l) => loanView(l, today)),
    reservations: reservations.map((r) => ({ _id: r._id, book: r.book, status: r.status, createdAt: r.createdAt, holdUntilDay: r.holdUntilDay || null })),
  };
};

// What a student sees in the library portal and what the chatbot may say about them.
export const studentSummary = async (userId) => {
  const [today, rules, currency] = await Promise.all([libraryToday(), LibraryRules.getRules(), getCurrency()]);
  const loans = await withLoanRefs(LibraryLoan.find({ student: userId }).sort({ issuedAt: -1 }).limit(500)).lean();
  const reservations = await LibraryReservation.find({ student: userId, status: { $in: [RS.WAITING, RS.READY] } }).populate('book', 'title bookId').lean();
  const waiting = await Promise.all(reservations.map(async (r) => ({
    _id: r._id, book: r.book, status: r.status, holdUntilDay: r.holdUntilDay || null, createdAt: r.createdAt,
    position: r.status === RS.WAITING ? await LibraryReservation.countDocuments({ book: r.book._id, status: RS.WAITING, createdAt: { $lte: r.createdAt } }) : 0,
  })));
  const views = loans.map((l) => loanView(l, today));
  return {
    today, currency, totals: studentTotals(loans, today),
    current: views.filter((l) => l.status === LS.ISSUED).sort((a, b) => a.dueDay.localeCompare(b.dueDay)),
    history: views.filter((l) => l.status !== LS.ISSUED),
    unpaid: views.filter((l) => l.status !== LS.ISSUED && l.pending > 0),
    reservations: waiting,
    rules: { loanDays: rules.loanDays, maxBooksPerStudent: rules.maxBooksPerStudent, maxRenewals: rules.maxRenewals, renewDays: rules.renewDays, finePerDay: rules.finePerDay, graceDays: rules.graceDays, reservationHoldDays: rules.reservationHoldDays },
  };
};

// ---------------------------------------------------------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------------------------------------------------------
export const libraryOverview = async () => {
  const [today, currency] = await Promise.all([libraryToday(), getCurrency()]);
  const [titles, copyRows, openLoans, closedMoney, returnedTotal, lostTotal, issuedToday, returnedToday, totalStudents, reservationRows, complaintRows, trendIssued, trendReturned] = await Promise.all([
    Book.countDocuments({ status: 'active' }),
    BookCopy.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    LibraryLoan.find({ status: LS.ISSUED }).populate('student', 'name').populate('book', 'title').lean(),
    LibraryLoan.aggregate([
      { $match: { status: { $in: [LS.RETURNED, LS.LOST] } } },
      { $project: {
        charged: { $add: ['$fine.accrued', { $sum: '$penalties.amount' }] },
        paid: { $sum: { $map: { input: { $filter: { input: '$payments', cond: { $eq: ['$$this.kind', 'payment'] } } }, in: '$$this.amount' } } },
        waived: { $sum: { $map: { input: { $filter: { input: '$payments', cond: { $eq: ['$$this.kind', 'waiver'] } } }, in: '$$this.amount' } } },
      } },
      { $group: { _id: null, charged: { $sum: '$charged' }, paid: { $sum: '$paid' }, waived: { $sum: '$waived' }, pending: { $sum: { $max: [0, { $subtract: ['$charged', { $add: ['$paid', '$waived'] }] }] } } } },
    ]),
    LibraryLoan.countDocuments({ status: LS.RETURNED }),
    LibraryLoan.countDocuments({ status: LS.LOST }),
    LibraryLoan.countDocuments({ issuedDay: today }),
    LibraryLoan.countDocuments({ returnedDay: today, status: LS.RETURNED }),
    StudentProfile.countDocuments({ status: 'active' }),
    LibraryReservation.aggregate([{ $match: { status: { $in: [RS.WAITING, RS.READY] } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Complaint.aggregate([{ $match: { source: 'library' } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    LibraryLoan.aggregate([{ $match: { issuedDay: { $gte: addDays(today, -13) } } }, { $group: { _id: '$issuedDay', n: { $sum: 1 } } }]),
    LibraryLoan.aggregate([{ $match: { returnedDay: { $gte: addDays(today, -13) }, status: LS.RETURNED } }, { $group: { _id: '$returnedDay', n: { $sum: 1 } } }]),
  ]);

  const copies = Object.fromEntries(copyRows.map((r) => [r._id, r.n]));
  const overdueLoans = openLoans.filter((l) => l.dueDay < today);
  let liveFines = 0;
  for (const l of openLoans) liveFines += loanState(l, today).fine;
  const m = closedMoney[0] || { charged: 0, paid: 0, waived: 0, pending: 0 };
  const round = (n) => Math.round(n * 100) / 100;
  const res = Object.fromEntries(reservationRows.map((r) => [r._id, r.n]));
  const comp = Object.fromEntries(complaintRows.map((r) => [r._id, r.n]));
  const tI = new Map(trendIssued.map((r) => [r._id, r.n]));
  const tR = new Map(trendReturned.map((r) => [r._id, r.n]));

  const staff = await User.find({ role: ROLES.LIBRARY_CONTROLLER, isActive: true }).select('name').lean();
  const att = await StaffAttendance.find({ date: today, user: { $in: staff.map((s) => s._id) } }).select('user status checkInAt minutesLate').lean();
  const attBy = new Map(att.map((a) => [String(a.user), a]));

  return {
    today, currency,
    books: {
      titles, copies: Object.entries(copies).filter(([k]) => k !== CS.WITHDRAWN).reduce((s, [, n]) => s + n, 0),
      available: copies[CS.AVAILABLE] || 0, issued: copies[CS.ISSUED] || 0, reserved: copies[CS.RESERVED] || 0, lost: copies[CS.LOST] || 0, damaged: copies[CS.DAMAGED] || 0,
    },
    loans: { issued: openLoans.length, overdue: overdueLoans.length, returned: returnedTotal, lost: lostTotal, issuedToday, returnedToday },
    fines: { pending: round(m.pending + liveFines), accruing: round(liveFines), collected: round(m.paid), waived: round(m.waived) },
    students: {
      total: totalStudents, withBooks: new Set(openLoans.map((l) => String(l.student?._id))).size, withOverdue: new Set(overdueLoans.map((l) => String(l.student?._id))).size,
    },
    reservations: { waiting: res[RS.WAITING] || 0, ready: res[RS.READY] || 0 },
    complaints: { open: (comp.open || 0) + (comp.in_review || 0), resolved: comp.resolved || 0, total: Object.values(comp).reduce((s, n) => s + n, 0) },
    trend: Array.from({ length: 14 }, (_, i) => { const d = addDays(today, i - 13); return { day: d, issued: tI.get(d) || 0, returned: tR.get(d) || 0 }; }),
    mostOverdue: overdueLoans.sort((a, b) => a.dueDay.localeCompare(b.dueDay)).slice(0, 8).map((l) => ({
      _id: l._id, student: l.student?.name, rollNumber: l.rollNumber, book: l.book?.title, dueDay: l.dueDay, overdueDays: loanState(l, today).overdueDays, fine: loanState(l, today).fine,
    })),
    staff: staff.map((s) => ({ _id: s._id, name: s.name, status: attBy.get(String(s._id))?.status || 'not_marked', checkInAt: attBy.get(String(s._id))?.checkInAt || null, minutesLate: attBy.get(String(s._id))?.minutesLate || 0 })),
  };
};
