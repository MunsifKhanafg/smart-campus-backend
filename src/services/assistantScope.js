import { ROLES } from '../config/constants.js';

// ==========================================================================================================
// Role-based access for the AI assistant (pure functions, no database, unit tested).
//
//   principal (university_head) : the whole college. Academic AND finance information.
//   finance officer             : the whole college, FINANCE information only (no attendance, marks, teachers, courses).
//   HOD (department chatbot)    : ONLY their own department. Academic and the fee figures of their own department.
//
// Anything not listed here has no assistant. A department user without a department gets nothing (fail closed).
// ==========================================================================================================
const ACCESS = {
  [ROLES.UNIVERSITY_HEAD]: { label: 'Principal', collegeWide: true, academic: true, finance: true },
  [ROLES.FINANCE_OFFICER]: { label: 'Finance office', collegeWide: true, academic: false, finance: true },
  [ROLES.HOD]: { label: 'Head of department', collegeWide: false, academic: true, finance: true },
};

export const scopeOf = (user) => {
  const a = ACCESS[user?.role];
  if (!a) return null;
  const dep = user.department?._id ?? user.department;
  const departmentId = a.collegeWide ? null : dep ? String(dep) : null;
  if (!a.collegeWide && !departmentId) return null; // a department user without a department sees nothing
  return { ...a, role: user.role, departmentId };
};

// ---------- departments named in a question ----------
const GENERIC = new Set(['department', 'departments', 'faculty', 'school', 'studies', 'science', 'sciences']);
const nameWordsOf = (d) => (d.name.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !GENERIC.has(w));

// Every word that belongs to a department (code and name words). The records search must not treat them as a person's name.
export const departmentWords = (departments = []) =>
  new Set(departments.flatMap((d) => [d.code.toLowerCase(), ...(d.name.toLowerCase().match(/[a-z]{3,}/g) || [])]));

const codeMentioned = (text, code) => {
  const c = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?<![A-Za-z0-9-])${c.toUpperCase()}(?![A-Za-z0-9-])`).test(text)) return true; // "CS", never inside a roll number "CS-S1-03"
  return /\b(dept|depts|department)\b/i.test(text) && new RegExp(`(?<![A-Za-z0-9-])${c}(?![A-Za-z0-9-])`, 'i').test(text);
};

// Which departments does the question name? By code, by full name, or by a word that belongs to ONE department only.
export const matchDepartments = (question, departments = []) => {
  const text = String(question || '');
  const lower = text.toLowerCase();
  const words = [...new Set(lower.match(/[a-z]{4,}/g) || [])];
  const count = new Map();
  for (const d of departments) for (const w of new Set(nameWordsOf(d))) count.set(w, (count.get(w) || 0) + 1);
  return departments.filter((d) =>
    codeMentioned(text, d.code) ||
    lower.includes(d.name.toLowerCase()) ||
    nameWordsOf(d).some((n) => count.get(n) === 1 && words.some((w) => n.startsWith(w) || w.startsWith(n)))
  );
};

// ---------- what is being asked ----------
const SEM_RX = /semester\s*(?:no\.?|number|#)?\s*(\d{1,2})|(\d{1,2})\s*(?:st|nd|rd|th)?\s*semester|\bsem\.?\s*(\d{1,2})\b/;

export const parseIntent = (question) => {
  const lower = String(question || '').toLowerCase();
  const has = (rx) => rx.test(lower);
  const sem = lower.match(SEM_RX);
  const flags = {
    counting: has(/\b(how many|total|count|number of|strength|headcount)\b/),
    students: has(/\b(students?|pupils?|enrolled|enrolment|admissions?)\b/),
    teachers: has(/\b(teachers?|faculty|lecturers?|professors?|instructors?|teaching staff)\b/),
    courses: has(/\b(courses?|subjects?|curricul\w+|credit hours?|timetable)\b/),
    departments: has(/\b(departments?|depts?|hods?)\b/),
    semesterWise: has(/semester|\bsem\b/),
    fees: has(/\b(fees?|revenue|collect\w*|pending|outstanding|unpaid|dues?|income|receivables?|refund\w*|payments?|paid|challans?|receipts?|balance|financ\w*|money)\b/),
    examFee: has(/\bexam\w*\b/),
    promotionFee: has(/promot/),
    performance: has(/\b(pass(?:ed)?|fail(?:ed)?|results?|gpa|grades?|percentage|performance|toppers?|marks|academic)\b/),
    attendance: has(/\b(attend\w*|absent\w*)\b/),
    report: has(/\b(reports?|summary|overview|statistics|stats|overall|breakdown|analysis|wise)\b/),
    top: has(/\b(top|best|highest|topper|toppers)\b/),
    low: has(/\b(lowest|worst|weakest|failing)\b/),
    college: has(/\b(college|university|campus|whole|entire|all departments|every department)\b/),
  };
  const listWords = has(/\b(list|names?|who (?:are|is)|display|every|each|details?|records?|roster)\b|\bshow( me)?( all)?( the)? (students?|teachers?|faculty)\b|\ball (the )?(students?|teachers?|faculty|staff)\b/);
  const peopleList = (flags.students || flags.teachers) && listWords && !flags.top && !flags.low && !(flags.counting && !has(/\b(list|names?|display)\b/));
  const any = Object.values(flags).some(Boolean);
  return {
    ...flags,
    semester: sem ? Number(sem[1] || sem[2] || sem[3]) : null,
    peopleList,
    wantsFinance: flags.fees || flags.examFee || flags.promotionFee,
    any,
    // A question about the whole picture (totals, reports, lists) rather than one person.
    strong: flags.counting || flags.report || flags.departments || peopleList || flags.semesterWise,
  };
};
