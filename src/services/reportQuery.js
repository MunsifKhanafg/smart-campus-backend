import { ROLES } from '../config/constants.js';

// ==========================================================================================================
// Understanding "report" questions of the AI assistant (pure functions, no database, unit tested):
//   "how many students are in semester 3?"  ·  "list all teachers"  ·  "total pending fees"
//   "department-wise fee report"  ·  "promotion fee collected"  ·  "pass rate of the college"
// reportsContext.js reads the numbers from the database; this file only decides WHAT is being asked and WHO may ask it.
// ==========================================================================================================

// What each role may ask about. One line per role, change it here.
//   principal      : everything in the college
//   HOD            : everything, but ONLY for their own department (the scope is forced in reportsContext.js)
//   finance office : fees and money only, college-wide
export const TOPICS_BY_ROLE = {
  [ROLES.UNIVERSITY_HEAD]: ['students', 'teachers', 'courses', 'finance', 'performance', 'overview'],
  [ROLES.HOD]: ['students', 'teachers', 'courses', 'finance', 'performance', 'overview'],
  [ROLES.FINANCE_OFFICER]: ['finance'],
};

const COUNT_WORDS = /\b(how many|total|totals|count|number of|strength)\b/;
const LIST_WORDS = /\b(all|list|every|each|show|display|names?|details?|who)\b/;
const STATS_WORDS = /\b(statistics|stats|report|reports|summary|overview|breakdown|wise|average|compare|comparison)\b/;
const AGG_WORDS = /\b(how many|total|totals|all|list|every|each|statistics|stats|report|reports|summary|overview|wise|collected|collection|revenue|pending|outstanding|unpaid|defaulters?|arrears|income|pass rate|average|count|number of|breakdown|college|university|departments?|hods?|strength|toppers?|top|highest|lowest|compare|comparison)\b/;

// Words of a report question that are NOT part of a person's name (the person search ignores them).
export const REPORT_STOP = new Set(
  `semester semesters sem wise collected collection collect revenue pending outstanding unpaid dues defaulter defaulters arrears income balance paid
  payments payment finance financial totals count counts numbers many list lists every each names display show top highest lowest best average statistics stats
  report reports performance pass passed fail failed rate toppers topper academic grades curriculum currently current now our own whole entire across between
  compare comparison breakdown per by also more less than any not been being was were had will would could should may might into out only just very most
  other another same such these those if because while during before after wise teach teaches taught teaching enrolled strength head heads principal
  revenue receipts receipt amount amounts money rupees pkr paying pay pays owe owes owed remaining remain left due over under`.split(/\s+/)
);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const GENERIC = new Set(['department', 'departments', 'science', 'sciences', 'studies', 'engineering', 'technology', 'management', 'arts', 'applied', 'faculty', 'college', 'university', 'school', 'institute']);

// Which departments does the question name? By code ("CS") or by name ("Computer Science", or its distinctive word "computer").
export const resolveDepartments = (question, departments = []) => {
  const clean = String(question || '').replace(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g, ' ');
  const text = ` ${norm(clean)} `;
  const words = new Set(text.split(' ').filter(Boolean));
  const strong = departments.filter((d) => text.includes(` ${norm(d.code)} `) || text.includes(` ${norm(d.name)} `));
  if (strong.length) return strong;
  return departments.filter((d) => norm(d.name).split(' ').some((w) => w.length >= 4 && !GENERIC.has(w) && words.has(w)));
};

// Every word of every department name and code: these are not a person's name either.
export const departmentWords = (departments = []) => {
  const set = new Set();
  for (const d of departments) for (const w of norm(`${d.name} ${d.code}`).split(' ')) if (w.length >= 2) set.add(w);
  return set;
};

// Reads one question: which topics, which semester, which kind of fee, list or only numbers.
export const parseReportQuery = (question) => {
  const l = String(question || '').toLowerCase();
  const has = (rx) => rx.test(l);
  const topics = [];
  if (has(/\bstudents?\b|\bclassmates?\b/)) topics.push('students');
  if (has(/\b(teachers?|faculty|lecturers?|professors?|instructors?)\b/)) topics.push('teachers');
  if (has(/\b(courses?|subjects?|curricul\w+)\b/)) topics.push('courses');
  if (has(/\b(fees?|revenue|collect\w*|pending|outstanding|unpaid|dues?|defaulters?|income|receipts?|payments?|finance|financial|balance|arrears|paid)\b/)) topics.push('finance');
  if (has(/\b(pass(?:ed)?\s*rate|performance|results?|gpa|pass|fail(?:ed|ure)?s?|academic|attendance|toppers?|grades?)\b/)) topics.push('performance');
  if (has(/\b(overview|summary|statistics|stats|report|reports|college|university|departments?|hods?)\b/)) topics.push('overview');

  const sem = l.match(/semester\s*(?:no\.?|number)?\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*semester/);
  let feeType = null;
  if (has(/\bpromotion\b/)) feeType = 'promotion';
  else if (has(/\bpractical/)) feeType = 'practical';
  else if (has(/\bexam\w*\s+fees?\b|\bfees?\s+(?:for|of)\s+exam/)) feeType = 'examination';

  return {
    topics,
    semester: sem ? Number(sem[1] || sem[2]) : null,
    feeType,
    countOnly: has(COUNT_WORDS),
    wantsList: has(LIST_WORDS) || (!has(COUNT_WORDS) && !has(STATS_WORDS)),
    agg: has(AGG_WORDS),
    bySemester: has(/semester[\s-]*wise|per semester|by semester|each semester|every semester/),
    byDepartment: has(/department[\s-]*wise|dept[\s-]*wise|per department|by department|each department|every department|all departments/),
    defaulters: has(/\bdefaulters?\b|\b(unpaid|not paid|pending|outstanding|dues?|arrears)\b.*\bstudents?\b|\bstudents?\b.*\b(unpaid|not paid|pending|outstanding|dues?|have not paid|haven'?t paid)\b/),
    top: has(/\b(top|toppers?|best|highest)\b/),
    collegeWide: has(/\b(college|university|whole|entire|overall|all departments)\b/),
  };
};

// A question about numbers / lists / reports (not about one named person). A roll number or e-mail always means one person.
// "fees of Ali Khan" stays a person search; "total pending fees" and "students of semester 3" become reports.
export const isAggregate = (report, { codes = [], emails = [], names = [] } = {}) =>
  !codes.length && !emails.length && report.topics.length > 0 && (report.agg || report.semester !== null || names.length === 0);

// Which of the asked topics this role may see. When nothing asked is allowed, `denied` lists them (the page says so politely).
export const grantTopics = (role, topics) => {
  const allowed = TOPICS_BY_ROLE[role] || [];
  const list = [...topics];
  // "college report" from the finance office means the financial report
  if (role === ROLES.FINANCE_OFFICER && list.includes('overview') && !list.includes('finance')) list.push('finance');
  const granted = list.filter((t) => allowed.includes(t));
  return { granted, denied: granted.length ? [] : list.filter((t) => !allowed.includes(t)) };
};
