// Pure rules of the library module (no database, no network), so they can be tested on their own (tests/library.test.js).
// The database work is in libraryService.js.

import { addDays } from './staffAttendanceRules.js';

const DAY_MS = 86400000;
const KEY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------------------------------------------------------
// Days. The college's local calendar days are plain "YYYY-MM-DD" strings, exactly as in the staff attendance module.
// ---------------------------------------------------------------------------------------------------------------------------
// a - b in whole days ("2026-03-10" - "2026-03-08" = 2)
export const diffDays = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
export const isDayKey = (s) => typeof s === 'string' && KEY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const dueDayFrom = (issuedDay, loanDays) => addDays(issuedDay, loanDays);

const money2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round2 = money2;

// ---------------------------------------------------------------------------------------------------------------------------
// Fines
// ---------------------------------------------------------------------------------------------------------------------------
// The late fine of one loan up to `endDay` (the day it was returned, or today while it is still out).
//   overdueDays    : days after the due day (0 when on time)
//   chargeableDays : overdue days minus the grace days
//   amount         : chargeableDays x perDay, never more than the cap
export const calcFine = ({ dueDay, endDay, perDay = 0, cap = null, grace = 0 }) => {
  const overdueDays = Math.max(0, diffDays(endDay, dueDay));
  const chargeableDays = Math.max(0, overdueDays - (grace || 0));
  let amount = chargeableDays * (perDay || 0);
  if (cap != null && Number.isFinite(cap)) amount = Math.min(amount, cap);
  return { overdueDays, chargeableDays, amount: money2(amount) };
};

// What the student owes for one loan.
//   charged = late fine + lost / damaged charges,  pending = charged - paid - waived (never below 0)
export const loanBalance = ({ fineAccrued = 0, penalties = [], payments = [] }) => {
  const penalty = penalties.reduce((s, p) => s + (p.amount || 0), 0);
  const paid = payments.filter((p) => p.kind === 'payment').reduce((s, p) => s + p.amount, 0);
  const waived = payments.filter((p) => p.kind === 'waiver').reduce((s, p) => s + p.amount, 0);
  const charged = money2(fineAccrued + penalty);
  return { fine: money2(fineAccrued), penalty: money2(penalty), charged, paid: money2(paid), waived: money2(waived), pending: money2(Math.max(0, charged - paid - waived)) };
};

// A lost book costs the price times the rule's multiplier plus the processing fee.
export const lostPenalty = ({ price = 0, multiplier = 1, processingFee = 0 }) => money2(price * multiplier + processingFee);

// ---------------------------------------------------------------------------------------------------------------------------
// Which reminder (if any) is due for a loan that is still out? The result is { kind, key, ... } or null.
//
//   before_due : on the configured days before the due day (rules.reminderBeforeDays, e.g. [3, 1])
//   due_today  : on the due day (rules.remindOnDueDay)
//   overdue    : after the due day, every `overdueReminderEveryDays` days, at most `maxOverdueReminders` times (0 = no limit)
//
// The key makes a reminder unique inside the loan: the job claims (loan, kind, key) in the database, so a reminder goes out ONCE,
// even when the job runs every few minutes. After a pause (server off for a day) the job catches up with ONE message, never a pile.
// ---------------------------------------------------------------------------------------------------------------------------
export const reminderDecision = ({ dueDay, issuedDay, todayKey, rules }) => {
  const toDue = diffDays(dueDay, todayKey);
  if (toDue > 0) {
    const span = diffDays(dueDay, issuedDay); // length of this loan in days
    // The nearest configured day that is not yet behind us. Days that are as long as the whole loan are skipped (the "issued" message covers that).
    const candidates = [...(rules.reminderBeforeDays || [])].filter((d) => d >= toDue && d >= 1 && d < span).sort((a, b) => a - b);
    return candidates.length ? { kind: 'before_due', key: `b${candidates[0]}`, daysLeft: toDue } : null;
  }
  if (toDue === 0) return rules.remindOnDueDay ? { kind: 'due_today', key: 'd0', daysLeft: 0 } : null;

  const over = -toDue;
  const every = Math.max(1, rules.overdueReminderEveryDays || 1);
  const slot = Math.floor((over - 1) / every);
  const max = rules.maxOverdueReminders || 0;
  if (max > 0 && slot >= max) return null;
  return { kind: 'overdue', key: `o${slot}`, overdueDays: over };
};

// How far the follow-up has to go for a loan that is `overdueDays` late.
export const escalationStage = ({ overdueDays, rules }) => ({
  department: overdueDays >= (rules.complaintAfterOverdueDays || Infinity),
  principal: overdueDays >= (rules.principalAfterOverdueDays || Infinity),
});

// ---------------------------------------------------------------------------------------------------------------------------
// Codes (barcodes)
// ---------------------------------------------------------------------------------------------------------------------------
export const makeCopyCode = (bookId, n) => `${bookId}-${String(n).padStart(2, '0')}`;
export const makeBookId = (seq) => `LB-${String(seq).padStart(6, '0')}`;
// What a scanner (or a person) typed: remove spaces and control characters, upper case. Scanners often add a trailing Enter or Tab.
export const normalizeCode = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, '').toUpperCase().slice(0, 40);
// A scanned QR code may carry a whole text ("LB-000012-01") or a link that ends with the code. Take the last code-looking part.
export const codeFromScan = (s) => {
  const raw = String(s ?? '').trim();
  const m = raw.match(/[A-Za-z0-9][A-Za-z0-9-]{1,38}[A-Za-z0-9]$/);
  return normalizeCode(m ? m[0] : raw);
};

// ---------------------------------------------------------------------------------------------------------------------------
// Text of the messages (kept short: a normal SMS is 160 characters, the provider joins longer ones)
// ---------------------------------------------------------------------------------------------------------------------------
const t = (title) => String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cur = (c) => (c ? `${c} ` : '');
export const smsText = {
  issued: ({ title, issuedDay, dueDay, currency, perDay }) =>
    `Library: "${t(title)}" was issued to you on ${issuedDay}. Please return it by ${dueDay}.${perDay > 0 ? ` Late fine: ${cur(currency)}${perDay} per day.` : ''}`,
  before_due: ({ title, dueDay, daysLeft }) => `Library reminder: "${t(title)}" is due on ${dueDay} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left). Please return it on time to avoid a fine.`,
  due_today: ({ title, dueDay }) => `Library reminder: "${t(title)}" is due TODAY (${dueDay}). Please return it today to avoid a fine.`,
  overdue: ({ title, dueDay, overdueDays, fine, currency }) =>
    `Library: "${t(title)}" was due on ${dueDay} and is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue.${fine > 0 ? ` Fine so far: ${cur(currency)}${fine}.` : ''} Please return it now.`,
  returned: ({ title, returnedDay, pending, currency }) => `Library: "${t(title)}" was returned on ${returnedDay}. Thank you.${pending > 0 ? ` Fine to pay at the library: ${cur(currency)}${pending}.` : ''}`,
  lost: ({ title, pending, currency }) => `Library: "${t(title)}" was recorded as lost.${pending > 0 ? ` Amount to pay at the library: ${cur(currency)}${pending}.` : ''} Please contact the library.`,
  reservation_ready: ({ title, holdUntilDay }) => `Library: the book you reserved, "${t(title)}", is ready. Please collect it by ${holdUntilDay}.`,
  reservation_expired: ({ title }) => `Library: your reservation of "${t(title)}" has expired because the book was not collected in time.`,
  fine: ({ title, amount, pending, currency }) => `Library: ${cur(currency)}${amount} received for "${t(title)}".${pending > 0 ? ` Still to pay: ${cur(currency)}${pending}.` : ' Nothing more to pay. Thank you.'}`,
};

// ---------------------------------------------------------------------------------------------------------------------------
// The library chatbot: what is the student asking about?
// ---------------------------------------------------------------------------------------------------------------------------
export const INTENT_PATTERNS = {
  howBorrow: /\b(how|steps?|process|procedure)\b.*\b(borrow|issue|take|get|check ?out|lend)\b|\bhow (can|do|to) i (borrow|get a book|take a book)\b/i,
  howReturn: /\b(how|where|steps?|process)\b.*\b(return|submit|give back|hand ?in|renew)\b|\bhow (can|do|to) i (return|renew)\b/i,
  reserve: /\b(reserve|reservation|hold|waiting list|queue)\b/i,
  fine: /\b(fine|fines|penalt(y|ies)|owe|owing|dues?|charges?|pending (amount|payment))\b/i,
  overdue: /\b(overdue|over due|late|not returned|missed|past due|passed the deadline)\b/i,
  deadline: /\b(deadline|due( date)?|return date|when .*(return|due)|last date|how many days left|days left)\b/i,
  borrowed: /\b(borrowed|issued|my books?|books? i (have|borrowed|took)|do i have|currently have|what .* i (have|borrowed)|history)\b/i,
  available: /\b(available|in stock|which books|what books|book list|list of books|books? (do you|are there)|catalog(ue)?|new arrivals?)\b/i,
  rules: /\b(rules?|policy|policies|limit|how many (books|days|times)|how long|loan period|renew(al)?s?)\b/i,
};
export const detectIntents = (message) => {
  const m = String(message || '');
  const found = new Set();
  for (const [name, rx] of Object.entries(INTENT_PATTERNS)) if (rx.test(m)) found.add(name);
  return found;
};

const STOP = new Set(('a an the is are was were be been do does did have has had i me my we you your it its of on in at to for from by with about and or not no any some ' +
  'which what when where who how can could would should please tell show give find search look want need like book books library available availability copies copy ' +
  'there here this that these those am will shall may might also than then them they their there borrow borrowed issue issued return returned reserve reserved ' +
  'much many more most less list all deadline due fine fines overdue pending').split(/\s+/));
// The words of a question that may be part of a title, author, subject or ISBN.
export const keywordsOf = (message, max = 6) => {
  const words = String(message || '').toLowerCase().replace(/["'`.,;:!?()[\]{}<>]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of words) if ((w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out.slice(0, max);
};

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------------------
export const pageParams = (query, { defaultLimit = 25, maxLimit = 100 } = {}) => {
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { limit, page, skip: (page - 1) * limit };
};
// "03001234567" -> "0300•••4567": the controller can see that a phone number exists without reading it all.
export const maskPhone = (p) => {
  const s = String(p || '').replace(/\s+/g, '');
  if (s.length < 7) return s ? '•••' : '';
  return `${s.slice(0, 4)}${'•'.repeat(Math.max(3, s.length - 8))}${s.slice(-4)}`;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Excel (.xlsx) without any extra package: an .xlsx file is a zip of small XML files, and the project already has jszip.
// buildXlsxFiles returns { "path/in/zip": "xml text" }; libraryReportService zips it.
// ---------------------------------------------------------------------------------------------------------------------------
export const xmlEscape = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const colName = (i) => { // 0 -> A, 25 -> Z, 26 -> AA
  let n = i + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

export const buildXlsxFiles = ({ sheetName = 'Report', title = '', summary = [], columns, rows }) => {
  const safeSheet = String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report';
  const lines = [];
  let r = 1;
  const text = (ref, v, style) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
  const num = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
  if (title) { lines.push(`<row r="${r}">${text(`A${r}`, title, 3)}</row>`); r += 1; }
  for (const [k, v] of summary) { lines.push(`<row r="${r}">${text(`A${r}`, k, 1)}${typeof v === 'number' ? num(`B${r}`, v) : text(`B${r}`, v)}</row>`); r += 1; }
  if (title || summary.length) r += 1; // an empty row before the table
  const headRow = r;
  lines.push(`<row r="${r}">${columns.map((c, i) => text(`${colName(i)}${r}`, c.label, 2)).join('')}</row>`);
  r += 1;
  for (const row of rows) {
    lines.push(`<row r="${r}">${columns.map((_, i) => {
      const v = row[i];
      const ref = `${colName(i)}${r}`;
      if (v === null || v === undefined || v === '') return '';
      return typeof v === 'number' && Number.isFinite(v) ? num(ref, v) : text(ref, v);
    }).join('')}</row>`);
    r += 1;
  }
  const lastCol = colName(Math.max(0, columns.length - 1));
  const cols = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, Math.min(60, c.width ? Math.round(c.width / 5.5) : 16))}" customWidth="1"/>`).join('');

  return {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    // styles: 0 normal, 1 bold, 2 bold white on dark blue (table header), 3 big bold (title)
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${Math.max(1, r - 1)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${lines.join('')}</sheetData></worksheet>`,
  };
};
