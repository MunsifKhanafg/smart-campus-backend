import Book from '../models/Book.js';
import BookCopy from '../models/BookCopy.js';
import LibraryLoan from '../models/LibraryLoan.js';
import LibraryReservation from '../models/LibraryReservation.js';
import LibraryRules from '../models/LibraryRules.js';
import LibraryMessage from '../models/LibraryMessage.js';
import AuditLog from '../models/AuditLog.js';
import Complaint from '../models/Complaint.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { smsEnabled } from '../services/smsService.js';
import * as lib from '../services/libraryService.js';
import { codeFromScan, normalizeCode, pageParams, escapeRegex } from '../services/libraryRules.js';
import { buildReport, sendReport } from '../services/libraryReportService.js';
import { ROLES, LOAN_STATUS as LS, BOOK_COPY_STATUS as CS, RESERVATION_STATUS as RS } from '../config/constants.js';

// The library API. Who may call what is decided in routes/library.js:
//   library controller : everything (the desk, the catalogue, rules, reports)
//   principal          : the same screens read-only (monitoring), plus the library rules
//   student            : the catalogue and their OWN books, fines, reservations and messages (always from the login, never from the request)
const paged = (items, total, page, limit) => ({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
const isStudent = (u) => u.role === ROLES.STUDENT;

// ---------------------------------------------------------------------------------------------------------------------------
// Dashboard, rules, categories
// ---------------------------------------------------------------------------------------------------------------------------
export const dashboard = asyncHandler(async (req, res) => {
  // Opening the dashboard also runs the reminder job (it skips itself when it ran a few minutes ago), so a host without timers still works.
  if (req.user.role === ROLES.LIBRARY_CONTROLLER) await lib.runLibraryJobs().catch((e) => console.error('Library job failed:', e.message));
  sendSuccess(res, await lib.libraryOverview());
});

export const getRules = asyncHandler(async (_req, res) => {
  sendSuccess(res, { ...lib.rulesView(await LibraryRules.getRules()), providerConfigured: smsEnabled(), currency: await lib.getCurrency() });
});

export const saveRules = asyncHandler(async (req, res) => {
  const rules = await LibraryRules.getRules();
  const body = { ...req.body };
  if (body.reminderBeforeDays) body.reminderBeforeDays = [...new Set(body.reminderBeforeDays)].sort((a, b) => b - a);
  rules.set({ ...body, updatedBy: req.user._id });
  await rules.save();
  lib.libLog(req.user, 'rules.update', 'LibraryRules', rules._id, { fields: Object.keys(req.body) }, req.ip);
  sendSuccess(res, { ...lib.rulesView(rules), providerConfigured: smsEnabled(), currency: await lib.getCurrency() }, 'Library rules saved');
});

export const categories = asyncHandler(async (_req, res) => {
  const [rules, used] = await Promise.all([LibraryRules.getRules(), Book.distinct('category', { status: 'active' })]);
  sendSuccess(res, [...new Set([...(rules.categories || []), ...used])].sort((a, b) => a.localeCompare(b)));
});

// ---------------------------------------------------------------------------------------------------------------------------
// Catalogue (staff and students)
// ---------------------------------------------------------------------------------------------------------------------------
export const listBooks = asyncHandler(async (req, res) => {
  const staff = !isStudent(req.user);
  const { page, limit, skip } = pageParams(req.query);
  const st = staff ? req.query.status : undefined; // a student only ever sees active books
  const filter = lib.buildBookFilter({ ...req.query, includeRemoved: st === 'removed' || st === 'all' });
  if (st === 'removed') filter.status = 'removed';
  const [rows, total] = await Promise.all([
    Book.find(filter).populate('department', 'name code').sort({ title: 1 }).skip(skip).limit(limit).lean(),
    Book.countDocuments(filter),
  ]);

  let items = rows.map((b) => lib.bookView(b, staff));
  if (!staff) {
    // What THIS student already has or waits for, so the page can show "You have it" / "Reserved" instead of a Reserve button.
    const ids = rows.map((b) => b._id);
    const [loans, reservations] = await Promise.all([
      LibraryLoan.find({ student: req.user._id, status: LS.ISSUED, book: { $in: ids } }).select('book dueDay').lean(),
      LibraryReservation.find({ student: req.user._id, status: { $in: [RS.WAITING, RS.READY] }, book: { $in: ids } }).select('book status holdUntilDay').lean(),
    ]);
    const have = new Map(loans.map((l) => [String(l.book), l]));
    const wait = new Map(reservations.map((r) => [String(r.book), r]));
    items = items.map((b) => ({
      ...b,
      mine: {
        borrowed: have.has(String(b._id)), dueDay: have.get(String(b._id))?.dueDay || null,
        reservation: wait.has(String(b._id)) ? { _id: wait.get(String(b._id))._id, status: wait.get(String(b._id)).status, holdUntilDay: wait.get(String(b._id)).holdUntilDay || null } : null,
      },
    }));
  }
  sendSuccess(res, paged(items, total, page, limit));
});

export const getBook = asyncHandler(async (req, res) => {
  const book = await Book.findById(req.params.id).populate('department', 'name code');
  if (!book) throw ApiError.notFound('Book not found');
  const copies = await BookCopy.find({ book: book._id }).sort({ code: 1 }).lean();
  const out = await LibraryLoan.find({ copy: { $in: copies.map((c) => c._id) }, status: LS.ISSUED }).populate('student', 'name').lean();
  const byCopy = new Map(out.map((l) => [String(l.copy), l]));
  const today = await lib.libraryToday();
  sendSuccess(res, {
    book: lib.bookView(book, true),
    copies: copies.map((c) => {
      const l = byCopy.get(String(c._id));
      return { _id: c._id, code: c.code, status: c.status, note: c.note, issuedTo: l ? { loanId: l._id, name: l.student?.name, rollNumber: l.rollNumber, dueDay: l.dueDay, overdue: l.dueDay < today } : null };
    }),
  });
});

export const createBook = asyncHandler(async (req, res) => {
  const book = await lib.createBook(req.body, req.user);
  sendSuccess(res, lib.bookView(book, true), `Book added with ${book.copiesTotal} cop${book.copiesTotal === 1 ? 'y' : 'ies'}`, 201);
});

export const updateBook = asyncHandler(async (req, res) => {
  const book = await Book.findById(req.params.id);
  if (!book) throw ApiError.notFound('Book not found');
  sendSuccess(res, lib.bookView(await lib.updateBook(book, req.body, req.user), true), 'Book updated');
});

export const removeBook = asyncHandler(async (req, res) => {
  const book = await Book.findOne({ _id: req.params.id, status: 'active' });
  if (!book) throw ApiError.notFound('Book not found');
  await lib.removeBook(book, req.user);
  sendSuccess(res, null, 'Book removed from the library. Its history is kept');
});

export const addCopies = asyncHandler(async (req, res) => {
  const book = await Book.findOne({ _id: req.params.id, status: 'active' });
  if (!book) throw ApiError.notFound('Book not found');
  const codes = await lib.addCopies(book, req.body.count, req.user, req.body.note || '');
  for (let i = 0; i < codes.length; i += 1) if (!(await lib.promoteReservation(book._id))) break; // students waiting for this title get the new copies
  lib.libLog(req.user, 'copy.add', 'Book', book._id, { title: book.title, count: codes.length }, req.ip);
  sendSuccess(res, { codes }, `${codes.length} cop${codes.length === 1 ? 'y' : 'ies'} added`, 201);
});

export const setCopyStatus = asyncHandler(async (req, res) => {
  const copy = await BookCopy.findById(req.params.id);
  if (!copy) throw ApiError.notFound('Copy not found');
  const done = await lib.setCopyStatus(copy, req.body.status, req.body.note, req.user);
  sendSuccess(res, { _id: done._id, code: done.code, status: done.status }, `${done.code} is now ${done.status}`);
});

// Barcode labels: one entry per copy. The page draws Code 128 barcodes and QR-ready text from the copy code.
export const labels = asyncHandler(async (req, res) => {
  const filter = { status: { $ne: CS.WITHDRAWN }, ...(req.query.book && { book: req.query.book }) };
  const copies = await BookCopy.find(filter).populate('book', 'title bookId shelf').sort({ code: 1 }).limit(600).lean();
  sendSuccess(res, copies.map((c) => ({ code: c.code, title: c.book?.title || '', bookId: c.book?.bookId || '', shelf: c.book?.shelf || '', status: c.status })));
});

// ---------------------------------------------------------------------------------------------------------------------------
// Students (the existing student records, read through the library)
// ---------------------------------------------------------------------------------------------------------------------------
export const students = asyncHandler(async (req, res) => sendSuccess(res, await lib.searchStudents({ q: req.query.q, holding: req.query.holding === 'true' })));
export const studentDetail = asyncHandler(async (req, res) => sendSuccess(res, await lib.studentHistory(req.params.id)));

// ---------------------------------------------------------------------------------------------------------------------------
// The desk: scan, issue, return, renew, lost, money
// ---------------------------------------------------------------------------------------------------------------------------
// One scan box for everything: a copy barcode, a book ID / ISBN, or a student roll number.
export const lookup = asyncHandler(async (req, res) => {
  const raw = String(req.query.code || '');
  const code = codeFromScan(raw);
  const today = await lib.libraryToday();

  const copy = await BookCopy.findOne({ code });
  if (copy) {
    const book = await Book.findById(copy.book);
    const loan = copy.status === CS.ISSUED ? await lib.withLoanRefs(LibraryLoan.findOne({ copy: copy._id, status: LS.ISSUED })).lean() : null;
    const held = copy.status === CS.RESERVED && copy.heldFor ? await LibraryReservation.findById(copy.heldFor).populate('student', 'name').lean() : null;
    return sendSuccess(res, {
      type: 'copy', copy: { _id: copy._id, code: copy.code, status: copy.status, note: copy.note },
      book: book ? lib.bookView(book, true) : null, loan: loan ? lib.loanView(loan, today) : null,
      heldFor: held ? { name: held.student?.name, rollNumber: held.rollNumber, holdUntilDay: held.holdUntilDay } : null,
    });
  }
  const book = await Book.findOne({ $or: [{ bookId: code }, { isbn: code }], status: 'active' });
  if (book) return sendSuccess(res, { type: 'book', book: lib.bookView(book, true) });
  try {
    const found = await lib.findStudent(normalizeCode(raw));
    const history = await lib.studentHistory(found.user._id);
    return sendSuccess(res, { type: 'student', student: history.student, totals: history.totals, current: history.loans.filter((l) => l.status === LS.ISSUED) });
  } catch { /* not a student either */ }
  throw ApiError.notFound(`Nothing in the library matches "${raw.slice(0, 60)}". Check the barcode or roll number`);
});

export const issue = asyncHandler(async (req, res) => {
  const r = await lib.issueBook({ student: normalizeCode(req.body.student), code: codeFromScan(req.body.code), issuer: req.user, days: req.body.days, ip: req.ip });
  const copy = await BookCopy.findById(r.loan.copy).select('code');
  sendSuccess(res, { loanId: r.loan._id, book: r.book.title, copyCode: copy?.code, student: r.student, issuedDay: r.loan.issuedDay, dueDay: r.loan.dueDay }, `"${r.book.title}" issued to ${r.student.name}. Return by ${r.loan.dueDay}`, 201);
});

export const returnBook = asyncHandler(async (req, res) => {
  const r = await lib.returnBook({ code: req.body.code ? codeFromScan(req.body.code) : undefined, loanId: req.body.loanId, condition: req.body.condition, damageFee: req.body.damageFee, note: req.body.note, receiver: req.user, ip: req.ip });
  const student = await User.findById(r.loan.student).select('name');
  sendSuccess(res, {
    book: r.book?.title, student: student?.name, rollNumber: r.loan.rollNumber, returnedDay: r.loan.returnedDay, overdueDays: r.overdueDays, fine: r.fine, pending: r.pending, condition: r.loan.returnCondition,
  }, r.pending > 0 ? `Returned. ${student?.name} has ${r.pending} to pay at the desk` : 'Returned. Nothing to pay');
});

export const renew = asyncHandler(async (req, res) => {
  const loan = await lib.renewLoan({ loanId: req.body.loanId, actor: req.user, ip: req.ip });
  sendSuccess(res, { dueDay: loan.dueDay, renewals: loan.renewals }, `Renewed. The new return date is ${loan.dueDay}`);
});

export const markLost = asyncHandler(async (req, res) => {
  const r = await lib.markLost({ loanId: req.body.loanId, amount: req.body.amount, note: req.body.note, actor: req.user, ip: req.ip });
  sendSuccess(res, { charged: r.charged }, `Recorded as lost. The student owes ${r.charged}. A complaint was sent to the department`);
});

export const payment = asyncHandler(async (req, res) => {
  const r = await lib.recordPayment({ loanId: req.body.loanId, kind: req.body.kind, amount: req.body.amount, note: req.body.note, actor: req.user, ip: req.ip });
  sendSuccess(res, { pending: r.pending }, req.body.kind === 'payment' ? `Payment recorded. ${r.pending} still to pay` : `Waived. ${r.pending} still to pay`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Loans, reservations, messages, complaints, activity
// ---------------------------------------------------------------------------------------------------------------------------
export const listLoans = asyncHandler(async (req, res) => {
  const today = await lib.libraryToday();
  const { page, limit, skip } = pageParams(req.query);
  const status = req.query.status || 'open';
  const filter = {};
  if (status === 'open') filter.status = LS.ISSUED;
  else if (status === 'overdue') Object.assign(filter, { status: LS.ISSUED, dueDay: { $lt: today } });
  else if (status === 'returned') filter.status = LS.RETURNED;
  else if (status === 'lost') filter.status = LS.LOST;
  else if (status === 'unpaid') Object.assign(filter, { status: { $in: [LS.RETURNED, LS.LOST] }, $or: [{ 'fine.accrued': { $gt: 0 } }, { 'penalties.0': { $exists: true } }] });
  if (req.query.department) filter.department = req.query.department;
  if (req.query.from || req.query.to) filter.issuedDay = { ...(req.query.from && { $gte: req.query.from }), ...(req.query.to && { $lte: req.query.to }) };
  const term = String(req.query.q || '').trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), 'i');
    const [bookIds, userIds] = await Promise.all([Book.find({ title: rx }).limit(100).distinct('_id'), User.find({ role: ROLES.STUDENT, name: rx }).limit(100).distinct('_id')]);
    filter.$and = [{ $or: [{ rollNumber: rx }, { book: { $in: bookIds } }, { student: { $in: userIds } }] }];
  }

  const sort = ['open', 'overdue'].includes(status) ? { dueDay: 1 } : { issuedAt: -1 };
  const base = () => lib.withLoanRefs(LibraryLoan.find(filter)).populate('department', 'name code').sort(sort);
  let rows;
  let total;
  if (status === 'unpaid') { // the balance is computed, so filter after reading (up to 1000 loans)
    const all = (await base().limit(1000).lean()).filter((l) => lib.loanState(l, today).pending > 0);
    total = all.length;
    rows = all.slice(skip, skip + limit);
  } else {
    [rows, total] = await Promise.all([base().skip(skip).limit(limit).lean(), LibraryLoan.countDocuments(filter)]);
  }
  const items = rows.map((l) => ({ ...lib.loanView(l, today), department: l.department ? { name: l.department.name, code: l.department.code } : null }));
  sendSuccess(res, { ...paged(items, total, page, limit), today });
});

export const listReservations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const status = req.query.status || 'open';
  const filter = status === 'open' ? { status: { $in: [RS.WAITING, RS.READY] } } : status === 'all' ? {} : { status };
  const [rows, total] = await Promise.all([
    LibraryReservation.find(filter).populate('book', 'title bookId').populate('student', 'name').sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
    LibraryReservation.countDocuments(filter),
  ]);
  sendSuccess(res, paged(rows.map((r) => ({ _id: r._id, book: r.book, student: r.student?.name, rollNumber: r.rollNumber, status: r.status, createdAt: r.createdAt, holdUntilDay: r.holdUntilDay || null, note: r.note })), total, page, limit));
});

export const cancelReservation = asyncHandler(async (req, res) => {
  await lib.cancelReservation({ id: req.params.id, actor: req.user });
  sendSuccess(res, null, 'Reservation cancelled');
});

export const listMessages = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.kind) filter.kind = req.query.kind;
  const [rows, total, counts] = await Promise.all([
    LibraryMessage.find(filter).populate('student', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    LibraryMessage.countDocuments(filter),
    LibraryMessage.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const rolls = new Map((await StudentProfile.find({ user: { $in: rows.map((m) => m.student?._id) } }).select('user rollNumber').lean()).map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, {
    ...paged(rows.map((m) => ({ _id: m._id, student: m.student?.name, rollNumber: rolls.get(String(m.student?._id)) || '', kind: m.kind, status: m.status, text: m.text, at: m.createdAt })), total, page, limit),
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), smsConfigured: smsEnabled(),
  });
});

export const listActivity = asyncHandler(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, { defaultLimit: 40 });
  const q = String(req.query.q || '').trim();
  const filter = { action: q ? new RegExp(`^library\\..*${escapeRegex(q)}`, 'i') : /^library\./ };
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).populate('actor', 'name').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  sendSuccess(res, paged(rows.map((a) => ({ _id: a._id, at: a.createdAt, actor: a.actor?.name || 'System (automatic)', role: a.actorRole, action: a.action.replace(/^library\./, ''), meta: a.meta })), total, page, limit));
});

// The complaints the library filed about books that were not returned (the departments resolve them on the Complaints page).
export const listLibraryComplaints = asyncHandler(async (req, res) => {
  const filter = { source: 'library', ...(req.query.status && { status: req.query.status }) };
  const rows = await Complaint.find(filter).populate('department', 'name code').sort({ createdAt: -1 }).limit(200).lean();
  const ids = rows.map((c) => c.student);
  const [users, profiles] = await Promise.all([User.find({ _id: { $in: ids } }).select('name').lean(), StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean()]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, rows.map((c) => ({
    _id: c._id, subject: c.subject, category: c.category, recipient: c.recipient, status: c.status, createdAt: c.createdAt, resolvedAt: c.resolvedAt || null, resolution: c.resolution || '',
    student: name.get(String(c.student)) || '', rollNumber: roll.get(String(c.student)) || '', department: c.department ? { name: c.department.name, code: c.department.code } : null,
  })));
});

export const runJobsNow = asyncHandler(async (req, res) => {
  const r = await lib.runLibraryJobs({ force: true });
  lib.libLog(req.user, 'jobs.run', 'Library', null, r, req.ip);
  sendSuccess(res, r, r.skipped ? `Skipped: ${r.skipped}` : `Done. ${r.reminders} reminder(s) sent, ${r.newlyOverdue} newly overdue, ${r.complaints + r.principalComplaints} complaint(s) filed`);
});

export const report = asyncHandler(async (req, res) => {
  const data = await buildReport(req.params.type, req.query);
  await sendReport(res, data, req.query.format, req.user, req.ip);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The student's own library (always the logged-in student)
// ---------------------------------------------------------------------------------------------------------------------------
export const mySummary = asyncHandler(async (req, res) => {
  const [summary, profile] = await Promise.all([lib.studentSummary(req.user._id), StudentProfile.findOne({ user: req.user._id }).select('rollNumber')]);
  sendSuccess(res, { ...summary, rollNumber: profile?.rollNumber || '' });
});

export const myMessages = asyncHandler(async (req, res) => {
  const rows = await LibraryMessage.find({ student: req.user._id }).sort({ createdAt: -1 }).limit(60).select('kind text status createdAt').lean();
  sendSuccess(res, rows.map((m) => ({ _id: m._id, kind: m.kind, text: m.text, sms: m.status, at: m.createdAt })));
});

export const myReserve = asyncHandler(async (req, res) => {
  const r = await lib.reserveBook({ bookId: req.body.book, user: req.user });
  sendSuccess(res, { position: r.position, reservationId: r.reservation._id }, `"${r.book.title}" reserved. You are number ${r.position} in the waiting list`, 201);
});

export const myCancelReservation = asyncHandler(async (req, res) => {
  await lib.cancelReservation({ id: req.params.id, actor: req.user, isStudent: true });
  sendSuccess(res, null, 'Reservation cancelled');
});

export const myRenew = asyncHandler(async (req, res) => {
  const loan = await lib.renewLoan({ loanId: req.params.id, actor: req.user, isStudent: true, ip: req.ip });
  sendSuccess(res, { dueDay: loan.dueDay, renewals: loan.renewals }, `Renewed. The new return date is ${loan.dueDay}`);
});
