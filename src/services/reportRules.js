// ============================================================================================
// Chatbot reports: the pure rules (no database), so they are easy to unit test.
//
//   parseReportIntent  - understands a natural-language question: is it a total / statistics / report question, about which
//                        topic (people, courses, fees, performance), which department, semester and fee type.
//   reportScope        - ROLE-BASED ACCESS. Decides what the asking role may see and which departments it may reach.
//                          principal       : the whole college, every topic
//                          HOD             : ONLY their own department (fails closed when no department is set)
//                          finance officer : fees and collections of the whole college, nothing academic
//   pendingByNotice    - the unpaid-fee arithmetic.
// ============================================================================================

import { ROLES } from '../config/constants.js';

export const TOPICS_BY_ROLE = {
  [ROLES.UNIVERSITY_HEAD]: ['people', 'courses', 'fees', 'performance'],
  [ROLES.HOD]: ['people', 'courses', 'fees', 'performance'],
  [ROLES.FINANCE_OFFICER]: ['fees'],
};

export const TOPIC_LABEL = { people: 'students, teachers and departments', courses: 'courses and subjects', fees: 'fees and payments', performance: 'academic performance' };

const GENERIC = new Set(['department', 'dept', 'faculty', 'school', 'studies', 'college', 'university', 'bachelor', 'program', 'programme']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Which departments does the question name? By code ("CS") or by ALL the significant words of the name ("computer science").
// If nothing matches completely, a single department that matches by one word is accepted ("computer students").
// A code of 1 to 2 letters (IT, CS) counts only when it is typed in capitals, so the word "it" never selects a department.
export const mentionedDepartments = (question, departments = []) => {
  const text = String(question || '');
  const words = [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) || [])];
  const sig = (d) => (String(d.name || '').toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 4 && !GENERIC.has(w));
  const near = (w) => words.some((x) => x.length >= 4 && (w.startsWith(x) || x.startsWith(w)));
  const byCode = (d) => {
    const code = String(d.code || '');
    if (!code) return false;
    return code.length <= 2 ? new RegExp(`(^|[^A-Za-z0-9])${esc(code.toUpperCase())}([^A-Za-z0-9]|$)`).test(text) : words.includes(code.toLowerCase());
  };
  const full = departments.filter((d) => byCode(d) || (sig(d).length > 0 && sig(d).every(near)));
  if (full.length) return full;
  const partial = departments.filter((d) => sig(d).some(near));
  return partial.length === 1 ? partial : [];
};

// Understands the question. `topics` is empty when it is not a totals / statistics / report question (then the normal record search runs).
export const parseReportIntent = (question, departments = []) => {
  const t = String(question || '').toLowerCase();
  const sem = t.match(/semester\s*(?:no\.?|number)?\s*(\d{1,2})|(\d{1,2})\s*(?:st|nd|rd|th)?\s*semester/);
  const semester = sem ? Number(sem[1] || sem[2]) : null;

  const kinds = [];
  if (/\bexam(ination)?s?\b/.test(t) && /\bfees?\b/.test(t)) kinds.push('examination');
  if (/\bpromotion\b/.test(t)) kinds.push('promotion');
  if (/\bpractical\b/.test(t) && /\bfees?\b/.test(t)) kinds.push('practical');

  const aggregateCue = /\b(how many|how much|total|overall|entire|whole|all|every|each|per|wise|list|count|number|strength|report|summary|statistics|stats|overview|breakdown)\b/.test(t);
  const topics = new Set();

  const money = /\b(fees?|collect(?:ed|ion|ions)?|pending|outstanding|unpaid|revenue|dues?|income|receivable|receipts?|arrears|defaulters?)\b/.test(t);
  if (money && (aggregateCue || /\b(collected|collection|pending|outstanding|unpaid|revenue|income|receivable|arrears|defaulters?)\b/.test(t))) topics.add('fees');

  const people = /\b(students?|teachers?|faculty|staff|lecturers?|professors?|hods?|departments?)\b/.test(t);
  if (people && /\b(how many|total|count|number|strength|list|all|every|show|display|semester|wise|statistics|stats|report|overview|summary|each|per)\b/.test(t)) topics.add('people');

  if (/\b(courses?|subjects?)\b/.test(t) && /\b(list|all|every|show|how many|total|offered|which|what|semester|wise|each|per|report|overview|count|number)\b/.test(t)) topics.add('courses');

  if (/\b(performance|results?|pass(?:ed|ing)?|fail(?:ed|ure)?|gpa|grades?|toppers?|percentage|academic)\b/.test(t)
    && /\b(overall|college|department|semester|average|rate|report|statistics|stats|summary|how many|each|per|wise|total|all)\b/.test(t)) topics.add('performance');

  // "college report", "department overview": everything the role may see
  const overview = /\b(overview|summary|statistics|stats|report|profile|snapshot)\b/.test(t) && !topics.size;
  if (overview) ['people', 'courses', 'fees', 'performance'].forEach((x) => topics.add(x));

  return {
    topics: [...topics],
    kinds,
    semester,
    deptMentions: mentionedDepartments(question, departments),
    byDepartment: /department[- ]?wise|per department|each department|by department|all departments|every department|\bdepartments\b/.test(t),
    bySemester: /semester[- ]?wise|per semester|each semester|by semester|all semesters/.test(t),
    overview,
  };
};

// ROLE-BASED ACCESS. Returns { topics, blocked, deptIds, denied }.
//   topics   : the topics this role may get for this question
//   blocked  : asked topics this role may NOT get (the answer says so)
//   deptIds  : departments the answer may cover (null = the whole college)
//   denied   : 'role' | 'no_department' | 'other_department' | null; when set, nothing is answered
// An HOD is locked to their own department: a question about another department is refused without looking anything up.
export const reportScope = (user, intent) => {
  const allowed = TOPICS_BY_ROLE[user?.role];
  if (!allowed) return { topics: [], blocked: intent.topics, deptIds: [], denied: 'role' };
  const topics = intent.topics.filter((x) => allowed.includes(x));
  const blocked = intent.topics.filter((x) => !allowed.includes(x));

  if (user.role === ROLES.HOD) {
    if (!user.department) return { topics: [], blocked: intent.topics, deptIds: [], denied: 'no_department' };
    const own = String(user.department);
    if (intent.deptMentions.some((d) => String(d._id) !== own)) return { topics: [], blocked: intent.topics, deptIds: [own], denied: 'other_department' };
    return { topics, blocked, deptIds: [own], denied: null };
  }
  const deptIds = intent.deptMentions.length ? intent.deptMentions.map((d) => String(d._id)) : null;
  return { topics, blocked, deptIds, denied: topics.length ? null : 'role' };
};

export const deniedMessage = (denied, blocked = []) => {
  if (denied === 'other_department') return 'You can only see the data of your own department. I cannot share information about other departments.';
  if (denied === 'no_department') return 'No department is linked to your account, so I cannot show department data. Please ask the principal to link your account to your department.';
  const names = blocked.map((b) => TOPIC_LABEL[b]).filter(Boolean).join(', ');
  return `Your role cannot see ${names || 'this information'}.`;
};

// ---------- fees ----------
const DAY_MS = 86400000;
const dayFloor = (d) => Math.floor(new Date(d).getTime() / DAY_MS) * DAY_MS;

// open = collecting now, overdue = the deadline day has passed, not_open = collection has not started yet
export const feeState = (notice, now = new Date()) => {
  if (dayFloor(notice.startDate) > now.getTime()) return 'not_open';
  return now.getTime() >= dayFloor(notice.dueDate) + DAY_MS ? 'overdue' : 'open';
};

// How much is still unpaid on each published fee notice.
//   eligible : Map("departmentId:semesterId" -> number of active students the notice applies to)
//   paid     : Map(noticeId -> number of students who paid it)
// pendingAmount = students who have not paid x the notice amount. Late fees and practical charges are not included
// (they depend on the day paid and on each student's choice). Notices that are not open yet are not counted as pending.
export const pendingByNotice = ({ notices, eligible, paid, now = new Date() }) =>
  notices.map((n) => {
    const state = feeState(n, now);
    const eligibleStudents = eligible.get(`${n.department}:${n.semester}`) || 0;
    const paidStudents = paid.get(String(n._id)) || 0;
    const unpaidStudents = Math.max(0, eligibleStudents - paidStudents);
    return { ...n, state, eligibleStudents, paidStudents, unpaidStudents, pendingAmount: state === 'not_open' ? 0 : unpaidStudents * Number(n.amount || 0) };
  });

export const sumPending = (rows) => ({
  pending: rows.reduce((t, r) => t + r.pendingAmount, 0),
  overdue: rows.filter((r) => r.state === 'overdue').reduce((t, r) => t + r.pendingAmount, 0),
  open: rows.filter((r) => r.state === 'open').reduce((t, r) => t + r.pendingAmount, 0),
  unpaidStudents: rows.filter((r) => r.state !== 'not_open').reduce((t, r) => t + r.unpaidStudents, 0),
  notOpenNotices: rows.filter((r) => r.state === 'not_open').length,
});
