import JSZip from 'jszip';
import Book from '../models/Book.js';
import BookCopy from '../models/BookCopy.js';
import LibraryLoan from '../models/LibraryLoan.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { renderTableReport } from './pdfService.js';
import { buildXlsxFiles } from './libraryRules.js';
import { libraryToday, getCurrency, loanState, withLoanRefs, searchStudents, libLog } from './libraryService.js';
import { sendSuccess } from '../utils/apiHelpers.js';
import { LOAN_STATUS as LS, BOOK_COPY_STATUS as CS } from '../config/constants.js';

// ============================================================================================================
// Library reports (PDF, Excel, or JSON for the screen). Every report is built from the live database, one function per type.
// A report is { title, filename, summary: [[label, value]], columns: [{ label, width }], rows: [[...]] }.
// ============================================================================================================

const LIMIT = 5000; // rows of one report
const authorsOf = (b) => (b?.authors || []).join(', ');
const sum = (rows, i) => Math.round(rows.reduce((s, r) => s + (Number(r[i]) || 0), 0) * 100) / 100;

const loanRange = (q) => {
  const f = {};
  if (q.from || q.to) f.issuedDay = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  if (q.department) f.department = q.department;
  return f;
};
const loansWithDept = (filter) => withLoanRefs(LibraryLoan.find(filter)).populate('department', 'code').limit(LIMIT);

const BUILDERS = {
  async inventory(q) {
    const filter = { status: 'active', ...(q.category && { category: q.category }) };
    const books = await Book.find(filter).sort({ category: 1, title: 1 }).limit(LIMIT).lean();
    const rows = books.map((b) => [b.bookId, b.title, authorsOf(b), b.category, b.shelf, b.copiesTotal, b.copiesAvailable, b.copiesIssued, b.copiesReserved, b.copiesLost, b.copiesDamaged, b.price || 0]);
    return {
      title: 'Library Inventory Report', filename: 'library-inventory',
      summary: [['Titles', books.length], ['Copies', sum(rows, 5)], ['Available', sum(rows, 6)], ['Issued', sum(rows, 7)], ['Lost', sum(rows, 9)], ['Damaged', sum(rows, 10)]],
      columns: [['Book ID', 70], ['Title', 150], ['Author(s)', 100], ['Category', 70], ['Shelf', 50], ['Total', 36], ['Avail.', 36], ['Issued', 36], ['Held', 32], ['Lost', 32], ['Dmg.', 32], ['Price', 44]].map(([label, width]) => ({ label, width })),
      rows,
    };
  },

  async issued(q, today) {
    const loans = await loansWithDept({ status: LS.ISSUED, ...loanRange(q) }).sort({ dueDay: 1 }).lean();
    const rows = loans.map((l) => { const s = loanState(l, today); return [l.rollNumber, l.student?.name, l.department?.code || '', l.book?.title, l.copy?.code, l.issuedDay, l.dueDay, s.state === 'overdue' ? `${s.overdueDays} late` : `${s.daysLeft} left`, s.fine]; });
    return {
      title: 'Currently Issued Books', filename: 'library-issued',
      summary: [['Books out', rows.length], ['Overdue', loans.filter((l) => l.dueDay < today).length], ['Fines accruing', sum(rows, 8)]],
      columns: [['Roll no.', 62], ['Student', 90], ['Dept.', 34], ['Book', 140], ['Copy', 66], ['Issued', 54], ['Due', 54], ['Status', 52], ['Fine', 36]].map(([label, width]) => ({ label, width })),
      rows,
    };
  },

  async overdue(q, today) {
    const loans = await loansWithDept({ status: LS.ISSUED, dueDay: { $lt: today }, ...loanRange(q) }).sort({ dueDay: 1 }).lean();
    const rows = loans.map((l) => { const s = loanState(l, today); return [l.rollNumber, l.student?.name, l.department?.code || '', l.book?.title, l.copy?.code, l.dueDay, s.overdueDays, s.fine, l.complaint ? 'Yes' : 'No']; });
    return {
      title: 'Overdue Books Report', filename: 'library-overdue',
      summary: [['Overdue books', rows.length], ['Fines so far', sum(rows, 7)]],
      columns: [['Roll no.', 62], ['Student', 90], ['Dept.', 34], ['Book', 140], ['Copy', 66], ['Was due', 54], ['Days late', 40], ['Fine', 36], ['Complaint', 44]].map(([label, width]) => ({ label, width })),
      rows,
    };
  },

  async history(q, today) {
    const range = loanRange(q);
    const filter = Object.keys(range).length ? range : { issuedDay: { $gte: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) } };
    const loans = await loansWithDept(filter).sort({ issuedAt: -1 }).lean();
    const rows = loans.map((l) => [l.rollNumber, l.student?.name, l.book?.title, l.copy?.code, l.issuedDay, l.dueDay, l.returnedDay || '', l.status, loanState(l, today).charged]);
    return {
      title: 'Issue and Return History', filename: 'library-history',
      summary: [['From', q.from || filter.issuedDay.$gte], ['To', q.to || today], ['Loans', rows.length], ['Returned', loans.filter((l) => l.status === LS.RETURNED).length], ['Still out', loans.filter((l) => l.status === LS.ISSUED).length]],
      columns: [['Roll no.', 62], ['Student', 90], ['Book', 140], ['Copy', 66], ['Issued', 54], ['Due', 54], ['Returned', 54], ['Status', 44], ['Charged', 40]].map(([label, width]) => ({ label, width })),
      rows,
    };
  },

  async fines(q, today) {
    const loans = await loansWithDept({ $or: [{ 'fine.accrued': { $gt: 0 } }, { 'penalties.0': { $exists: true } }, { status: LS.ISSUED, dueDay: { $lt: today } }], ...loanRange(q) }).sort({ issuedAt: -1 }).lean();
    const rows = loans.map((l) => { const s = loanState(l, today); return [l.rollNumber, l.student?.name, l.book?.title, l.status, s.fine, s.penalty, s.charged, s.paid, s.waived, s.pending]; }).filter((r) => r[6] > 0);
    return {
      title: 'Fines and Charges Report', filename: 'library-fines',
      summary: [['Loans with charges', rows.length], ['Charged', sum(rows, 6)], ['Paid', sum(rows, 7)], ['Waived', sum(rows, 8)], ['Still to pay', sum(rows, 9)]],
      columns: [['Roll no.', 62], ['Student', 90], ['Book', 130], ['Status', 44], ['Late fine', 44], ['Lost/dmg.', 44], ['Charged', 44], ['Paid', 40], ['Waived', 40], ['Pending', 44]].map(([label, width]) => ({ label, width })),
      rows,
    };
  },

  async 'lost-damaged'() {
    const copies = await BookCopy.find({ status: { $in: [CS.LOST, CS.DAMAGED] } }).populate('book', 'title bookId price').sort({ statusChangedAt: -1 }).limit(LIMIT).lean();
    const rows = copies.map((c) => [c.code, c.book?.title, c.status, c.note, c.statusChangedAt ? new Date(c.statusChangedAt).toISOString().slice(0, 10) : '', c.book?.price || 0]);
    return {
      title: 'Lost and Damaged Books', filename: 'library-lost-damaged',
      summary: [['Lost copies', copies.filter((c) => c.status === CS.LOST).length], ['Damaged copies', copies.filter((c) => c.status === CS.DAMAGED).length], ['Value of lost copies', copies.filter((c) => c.status === CS.LOST).reduce((s, c) => s + (c.book?.price || 0), 0)]],
      columns: [['Copy code', 80], ['Book', 170], ['Status', 50], ['Note', 130], ['Since', 56], ['Price', 40]].map(([label, width]) => ({ label, width })),
      rows,
    };
  },

  async students() {
    const list = await searchStudents({ holding: true });
    const rows = list.map((s) => [s.rollNumber, s.name, s.department?.code || '', s.semester, s.active, s.overdue, s.pending, s.lost, s.returned]);
    return {
      title: 'Students Holding Library Books', filename: 'library-students',
      summary: [['Students', rows.length], ['With overdue books', rows.filter((r) => r[5] > 0).length], ['Fines to collect', sum(rows, 6)]],
      columns: [['Roll no.', 70], ['Student', 120], ['Dept.', 40], ['Semester', 70], ['Books out', 44], ['Overdue', 44], ['Pending fine', 56], ['Lost', 32], ['Returned', 44]].map(([label, width]) => ({ label, width })),
      rows,
    };
  },
};

export const buildReport = async (type, query = {}) => {
  const today = await libraryToday();
  const currency = await getCurrency();
  const report = await BUILDERS[type](query, today);
  return { ...report, type, today, currency, generated: `Generated on ${today}`, summary: [...report.summary, ...(/fine|issued|overdue/.test(type) ? [['Currency', currency]] : [])] };
};

const zipXlsx = async (report) => {
  const files = buildXlsxFiles({
    sheetName: report.title.slice(0, 31), title: `${report.title} (${report.today})`, summary: report.summary,
    columns: report.columns.map((c) => ({ label: c.label, width: c.width * 5.5 })), rows: report.rows,
  });
  const zip = new JSZip();
  for (const [path, xml] of Object.entries(files)) zip.file(path, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};

// Sends the report in the format asked for and writes the download to the activity log.
export const sendReport = async (res, report, format, actor, ip = '') => {
  libLog(actor, 'report', 'Report', null, { type: report.type, format, rows: report.rows.length }, ip);
  const name = `${report.filename}-${report.today}`;
  if (format === 'xlsx') {
    const buffer = await zipXlsx(report);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(buffer);
  }
  if (format === 'pdf') {
    const settings = await UniversitySettings.getSettings();
    return renderTableReport(res, { settings, title: report.title, filename: `${name}.pdf`, summary: report.summary, columns: report.columns, rows: report.rows, generated: report.generated });
  }
  return sendSuccess(res, { title: report.title, today: report.today, summary: report.summary, columns: report.columns.map((c) => c.label), rows: report.rows });
};
