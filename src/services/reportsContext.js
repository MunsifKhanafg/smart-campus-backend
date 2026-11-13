import mongoose from 'mongoose';
import Department from '../models/Department.js';
import StudentProfile from '../models/StudentProfile.js';
import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import FeeNotice from '../models/FeeNotice.js';
import Payment from '../models/Payment.js';
import Result from '../models/Result.js';
import Attendance from '../models/Attendance.js';
import { ROLES, STUDENT_STATUS, COURSE_STATUS, PAYMENT_STATUS, FEE_NOTICE_STATUS, RESULT_STATUS } from '../config/constants.js';
import { parseReportIntent, reportScope, deniedMessage, pendingByNotice, sumPending, TOPIC_LABEL, TOPICS_BY_ROLE } from './reportRules.js';
import { REPORT_STOP, departmentWords } from './reportQuery.js';
import { parseRecordsQuery } from './recordsSearch.js';
import { loadPeople, peopleText, peopleFallback } from './peopleContext.js';

// ==========================================================================================================
// Chatbot reports: totals, statistics, lists and fee reports for the department (HOD), finance and principal assistants.
// Everything is read LIVE from the database on every question; nothing is guessed or cached.
//
//   reportRules.js    decides WHAT is asked and WHO may see it (the role-based access rules live there):
//                       principal       -> the whole college, every topic
//                       HOD             -> ONLY their own department (another department is refused before any lookup)
//                       finance office  -> fees and money of the whole college, nothing academic
//   this file         reads the numbers (people, courses, fees, performance) inside that scope and turns them into text.
//
// buildReport() returns null when the question is about ONE person (roll number, e-mail, a name): the normal records
// search (recordsSearch.js) answers those, exactly as before.
// ==========================================================================================================

const toIds = (list) => list.map((x) => new mongoose.Types.ObjectId(String(x)));
const money = (n) => `PKR ${Math.round(Number(n || 0)).toLocaleString('en-US')}`;
const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const show = (n) => (n === null || n === undefined ? 'n/a' : n);
const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

// Words of a report question that are not a person's name (on top of REPORT_STOP in reportQuery.js).
const EXTRA_STOP = new Set(
  `not who has haven have had last this month months year years week weeks today yesterday latest recent till date far type types kind kinds need want like say
  sem sems dept depts also examination examinations practical practicals curriculum earn earned earning earnings made make got money rupees amount amounts`.split(/\s+/)
);
const ORDINAL = /^\d{1,2}(ST|ND|RD|TH)$/; // "10th" looks like a code to the record search, but it is a semester number
const DEFAULTERS = /\b(defaulters?|unpaid students?|students? (?:who )?(?:have not|haven'?t|did not|didn'?t|has not|hasn'?t) paid|not paid|who (?:has|have) not paid|students? with (?:dues|pending|outstanding))\b/i;
const COUNT = /\b(how many|total|count|number of|strength)\b/i;
const LIST = /\b(list|show|display|names?|details?|who|every|all students|all teachers|roll)\b/i;
const TOP = /\b(top|toppers?|best|highest)\b/i;
// A short follow-up that only narrows the previous report ("and for semester 3?", "only promotion fees").
const REFINE = /\b(semester|sem|department|dept|exam\w*|promotion|practical|only|what about|how about|and)\b|\b\d{1,2}(st|nd|rd|th)\b/i;

// Pure: reads the question. isReport is true for "total pending fees" or "students of semester 3", false for "fees of Ali Khan",
// "attendance of CS-S1-03" or an e-mail (those are about one person and use the records search).
const classify = (question, departments = []) => {
  const asked = parseRecordsQuery(question);
  const skip = departmentWords(departments);
  const codes = asked.codes.filter((c) => !ORDINAL.test(c));
  const names = asked.names.filter((n) => {
    const w = n.toLowerCase();
    return !REPORT_STOP.has(w) && !EXTRA_STOP.has(w) && !skip.has(w);
  });
  const intent = parseReportIntent(question, departments);
  const defaulters = DEFAULTERS.test(String(question || ''));
  if (defaulters && !intent.topics.includes('fees')) intent.topics.push('fees');
  return { asked, codes, names, intent, defaulters, isReport: !codes.length && !asked.emails.length && !names.length && intent.topics.length > 0 };
};

export const isReportQuestion = (question, departments = []) => classify(question, departments).isReport;

// ---------- people: reuse the existing, already role-limited people search ----------
const peopleSection = async (user, question, intent) => {
  const countOnly = COUNT.test(question) && !LIST.test(question);
  let asked = question;
  if (countOnly) {
    // Only numbers are needed: ask for the department summary (counts per department and semester) instead of every person.
    const dept = intent.deptMentions.length === 1 ? ` ${intent.deptMentions[0].code}` : '';
    asked = `departments${intent.semester ? ` semester ${intent.semester}` : ''}${dept}`;
  }
  return loadPeople(user, asked);
};

// ---------- courses ----------
const courseSection = async ({ deptIds, intent, departments }) => {
  const dm = deptIds ? { department: { $in: toIds(deptIds) } } : {};
  const filter = { ...dm, status: COURSE_STATUS.ACTIVE };
  if (intent.semester) filter.semester = { $in: await Semester.find({ ...dm, number: intent.semester }).distinct('_id') };
  const [total, perSem, list] = await Promise.all([
    Course.countDocuments(filter),
    Course.aggregate([{ $match: filter }, { $group: { _id: { d: '$department', s: '$semester' }, n: { $sum: 1 }, credits: { $sum: '$creditHours' } } }]),
    Course.find(filter).populate('teacher', 'name').populate('semester', 'name number').populate('department', 'code').sort({ code: 1 }).limit(150).lean(),
  ]);
  const sems = new Map((await Semester.find({ _id: { $in: perSem.map((x) => x._id.s).filter(Boolean) } }).select('name number').lean()).map((s) => [String(s._id), s]));
  const code = new Map(departments.map((d) => [String(d._id), d.code]));
  return {
    total,
    perSemester: perSem
      .map((x) => ({ department: code.get(String(x._id.d)) || '', semester: sems.get(String(x._id.s))?.name || 'no semester', number: sems.get(String(x._id.s))?.number ?? 99, courses: x.n, credits: x.credits || 0 }))
      .sort((a, b) => a.department.localeCompare(b.department) || a.number - b.number),
    list: list.map((c) => ({ code: c.code, title: c.title, department: c.department?.code || '', semester: c.semester?.name || '', section: c.section, credits: c.creditHours, teacher: c.teacher?.name || 'not assigned' })),
  };
};

// ---------- fees ----------
// collected = money really received (paid payments, late fees included; refunded and failed payments are not counted).
// pending   = students who have not paid x the notice amount, for published notices that are open or overdue (see reportRules.pendingByNotice).
const feeSection = async ({ deptIds, intent, departments, wantDefaulters }) => {
  const dm = deptIds ? { department: { $in: toIds(deptIds) } } : {};
  const semIds = intent.semester ? await Semester.find({ ...dm, number: intent.semester }).distinct('_id') : null;
  const noticeFilter = { ...dm, status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] } };
  if (semIds) noticeFilter.semester = { $in: semIds };
  if (intent.kinds.length) noticeFilter.feeType = { $in: intent.kinds };

  const notices = await FeeNotice.find(noticeFilter).select('title feeType department semester amount startDate dueDate status').lean();
  const noticeIds = notices.map((n) => n._id);
  const noticeSemIds = [...new Set(notices.map((n) => String(n.semester)))].map((x) => new mongoose.Types.ObjectId(x));

  const [collectedRows, semesters, profiles, enrollRows, awaiting] = await Promise.all([
    noticeIds.length
      ? Payment.aggregate([
          { $match: { status: PAYMENT_STATUS.PAID, 'items.notice': { $in: noticeIds } } },
          { $unwind: '$items' },
          { $match: { 'items.notice': { $in: noticeIds } } },
          { $group: { _id: { n: '$items.notice', s: '$student' }, amount: { $sum: '$items.total' } } },
          { $group: { _id: '$_id.n', amount: { $sum: '$amount' }, students: { $sum: 1 } } },
        ])
      : [],
    Semester.find({ _id: { $in: noticeSemIds } }).select('name number department').lean(),
    StudentProfile.find({ status: STUDENT_STATUS.ACTIVE, ...dm }).select('user department semester').lean(),
    noticeSemIds.length ? CourseEnrollment.aggregate([{ $match: { semester: { $in: noticeSemIds } } }, { $group: { _id: { s: '$semester', st: '$student' } } }]) : [],
    Payment.aggregate([{ $match: { status: PAYMENT_STATUS.PENDING, method: 'bank', ...dm } }, { $group: { _id: null, n: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }]),
  ]);

  // Who belongs to each semester: placed in it now, or enrolled in it earlier (same rule as the fee screens).
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));
  const members = new Map();
  const add = (sem, user) => {
    const k = String(sem);
    if (!members.has(k)) members.set(k, new Set());
    members.get(k).add(String(user));
  };
  for (const p of profiles) if (p.semester) add(p.semester, p.user);
  for (const e of enrollRows) if (byUser.has(String(e._id.st))) add(e._id.s, e._id.st);
  const eligible = new Map(notices.map((n) => [`${n.department}:${n.semester}`, members.get(String(n.semester))?.size || 0]));

  const collected = new Map(collectedRows.map((r) => [String(r._id), r]));
  const paid = new Map(collectedRows.map((r) => [String(r._id), r.students]));
  const open = notices.filter((n) => n.status === FEE_NOTICE_STATUS.PUBLISHED);
  const pendingRows = pendingByNotice({ notices: open, eligible, paid });
  const pendingMap = new Map(pendingRows.map((r) => [String(r._id), r]));
  const sem = new Map(semesters.map((s) => [String(s._id), s]));
  const dept = new Map(departments.map((d) => [String(d._id), d]));

  const rows = notices.map((n) => {
    const p = pendingMap.get(String(n._id));
    const c = collected.get(String(n._id));
    const s = sem.get(String(n.semester));
    return {
      id: String(n._id), title: n.title, type: n.feeType, deptId: String(n.department), department: dept.get(String(n.department))?.code || '',
      semester: s?.name || '', number: s?.number ?? 99, amount: n.amount, due: n.dueDate ? new Date(n.dueDate).toISOString().slice(0, 10) : '-',
      state: p?.state || 'closed', collected: c?.amount || 0, paidStudents: c?.students || 0, unpaidStudents: p?.unpaidStudents || 0, pending: p?.pendingAmount || 0,
    };
  });

  const group = (keyOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const g = m.get(k.id) || { ...k, collected: 0, pending: 0, unpaidStudents: 0, notices: 0 };
      g.collected += r.collected;
      g.pending += r.pending;
      g.unpaidStudents += r.unpaidStudents;
      g.notices += 1;
      m.set(k.id, g);
    }
    return [...m.values()];
  };
  const totals = sumPending(pendingRows);

  const data = {
    totals: { collected: rows.reduce((t, r) => t + r.collected, 0), pending: totals.pending, overdue: totals.overdue, open: totals.open, unpaidItems: totals.unpaidStudents, notOpen: totals.notOpenNotices, notices: rows.length },
    awaiting: { payments: awaiting[0]?.n || 0, amount: awaiting[0]?.amount || 0 },
    byDepartment: group((r) => ({ id: r.deptId, label: r.department })).sort((a, b) => a.label.localeCompare(b.label)),
    bySemester: group((r) => ({ id: `${r.deptId}:${r.semester}`, label: `${r.department} ${r.semester}`, number: r.number, department: r.department })).sort((a, b) => a.department.localeCompare(b.department) || a.number - b.number),
    byType: group((r) => ({ id: r.type, label: r.type })).sort((a, b) => a.label.localeCompare(b.label)),
    notices: [...rows].sort((a, b) => a.department.localeCompare(b.department) || a.number - b.number || a.title.localeCompare(b.title)).slice(0, 40),
    noticesTotal: rows.length,
    defaulters: null,
    filters: { semester: intent.semester, kinds: intent.kinds },
  };

  if (wantDefaulters) {
    const owing = pendingRows.filter((r) => r.state !== 'not_open' && r.unpaidStudents > 0).slice(0, 40);
    const owingIds = owing.map((r) => r._id);
    const paidSets = owingIds.length
      ? await Payment.aggregate([
          { $match: { status: PAYMENT_STATUS.PAID, 'items.notice': { $in: owingIds } } },
          { $unwind: '$items' },
          { $match: { 'items.notice': { $in: owingIds } } },
          { $group: { _id: '$items.notice', students: { $addToSet: '$student' } } },
        ])
      : [];
    const paidBy = new Map(paidSets.map((r) => [String(r._id), new Set(r.students.map(String))]));
    const owes = new Map(); // student id -> { amount, items }
    for (const r of owing) {
      const done = paidBy.get(String(r._id)) || new Set();
      for (const uid of members.get(String(r.semester)) || []) {
        if (done.has(uid)) continue;
        const o = owes.get(uid) || { amount: 0, items: [] };
        o.amount += Number(r.amount || 0);
        o.items.push(r.title);
        owes.set(uid, o);
      }
    }
    const top = [...owes.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 60);
    const people = await StudentProfile.find({ user: { $in: top.map(([uid]) => uid) } }).populate('user', 'name').populate('department', 'code').populate('semester', 'name').select('user rollNumber department semester').lean();
    const info = new Map(people.map((p) => [String(p.user?._id), p]));
    data.defaulters = {
      total: owes.size,
      rows: top.map(([uid, o]) => {
        const p = info.get(uid);
        return { name: p?.user?.name || '', roll: p?.rollNumber || '', department: p?.department?.code || '', semester: p?.semester?.name || '', owes: o.amount, items: o.items.join('; ') };
      }),
    };
  }
  return data;
};

// ---------- academic performance ----------
const performanceSection = async ({ deptIds, intent, departments, wantTop }) => {
  const dm = deptIds ? { department: { $in: toIds(deptIds) } } : {};
  const resMatch = { ...dm, status: RESULT_STATUS.PUBLISHED, ...(intent.semester ? { semesterNumber: intent.semester } : {}) };
  const stats = { total: { $sum: 1 }, passed: { $sum: { $cond: [{ $eq: ['$outcome', 'pass'] }, 1, 0] } }, avg: { $avg: '$percentage' } };
  const [byDept, bySem, att, top] = await Promise.all([
    Result.aggregate([{ $match: resMatch }, { $group: { _id: '$department', ...stats } }]),
    Result.aggregate([{ $match: resMatch }, { $group: { _id: { d: '$department', s: '$semesterNumber' }, ...stats } }]),
    Attendance.aggregate([
      { $match: dm }, { $unwind: '$records' },
      { $group: { _id: '$department', total: { $sum: 1 }, attended: { $sum: { $cond: [{ $in: ['$records.status', ['present', 'leave']] }, 1, 0] } } } },
    ]),
    wantTop ? Result.find(resMatch).sort({ percentage: -1 }).limit(5).populate('student', 'name').populate('department', 'code').select('student department percentage grade semesterNumber').lean() : [],
  ]);
  const code = new Map(departments.map((d) => [String(d._id), d.code]));
  const attMap = new Map(att.map((a) => [String(a._id), a]));
  const rolls = top.length ? new Map((await StudentProfile.find({ user: { $in: top.map((t) => t.student?._id) } }).select('user rollNumber').lean()).map((p) => [String(p.user), p.rollNumber])) : new Map();
  const line = (r) => ({ results: r.total, passed: r.passed, passRate: rate(r.passed, r.total), average: r.avg === null || r.avg === undefined ? null : Math.round(r.avg * 10) / 10 });
  return {
    semester: intent.semester,
    byDepartment: byDept.map((r) => ({ department: code.get(String(r._id)) || '', ...line(r), attendance: attMap.get(String(r._id)) ? rate(attMap.get(String(r._id)).attended, attMap.get(String(r._id)).total) : null }))
      .sort((a, b) => a.department.localeCompare(b.department)),
    bySemester: bySem.map((r) => ({ department: code.get(String(r._id.d)) || '', semester: r._id.s, ...line(r) })).sort((a, b) => a.department.localeCompare(b.department) || a.semester - b.semester),
    top: top.map((t) => ({ name: t.student?.name || '', roll: rolls.get(String(t.student?._id)) || '', department: t.department?.code || '', semester: t.semesterNumber, percentage: t.percentage, grade: t.grade })),
  };
};

// ---------- entry point ----------
// user: the logged-in principal, HOD or finance officer. question: this message. previous: the user's previous message
// (used only for a short follow-up such as "and for semester 3?"). Returns null when this is not a report question,
// { denied: true, message } when the role may not see it, or the report data.
export const buildReport = async (user, question, previous = '') => {
  if (!TOPICS_BY_ROLE[user.role]) return null;
  const departments = await Department.find({ status: 'active' }).populate('hod', 'name email phone').select('name code hod').sort({ name: 1 }).lean();
  let text = String(question || '');
  let c = classify(text, departments);
  if (!c.isReport && previous && text.length <= 80 && !c.codes.length && !c.asked.emails.length && !c.names.length && REFINE.test(text)) {
    const joined = `${previous} ${text}`;
    const j = classify(joined, departments);
    if (j.isReport) { text = joined; c = j; }
  }
  if (!c.isReport) return null;

  const { intent } = c;
  const scope = reportScope(user, intent); // ROLE-BASED ACCESS: topics, departments, or a refusal
  if (scope.denied) return { denied: true, message: deniedMessage(scope.denied, scope.blocked), topics: intent.topics };

  const inScope = scope.deptIds ? departments.filter((d) => scope.deptIds.includes(String(d._id))) : departments;
  const names = inScope.map((d) => `${d.name} (${d.code})`).join(', ');
  const scopeLabel = user.role === ROLES.HOD ? `your own department only: ${names || 'department not found'}` : scope.deptIds ? names : 'the whole college';
  const want = new Set(scope.topics);
  const ids = scope.deptIds;

  const [people, courses, fees, performance] = await Promise.all([
    want.has('people') ? peopleSection(user, text, intent) : null,
    want.has('courses') ? courseSection({ deptIds: ids, intent, departments }) : null,
    want.has('fees') ? feeSection({ deptIds: ids, intent, departments, wantDefaulters: c.defaulters }) : null,
    want.has('performance') ? performanceSection({ deptIds: ids, intent, departments, wantTop: TOP.test(text) }) : null,
  ]);
  return { denied: false, scopeLabel, isHod: user.role === ROLES.HOD, topics: scope.topics, blocked: scope.blocked, deptIds: ids, intent, people, courses, fees, performance };
};

// ---------- presentation ----------
const FEE_BASIS = 'Collected = money received for paid payments (late fees included; refunded and failed payments are not counted). Pending = students who have not paid x the fee amount, for published fee notices that are open or overdue; late fees, practical extras, notices not open yet and closed notices are not included.';

// The facts as plain text for the AI model (it must not add anything that is not here).
export const reportText = (d) => {
  const out = [`Scope: ${d.scopeLabel}`];
  if (d.isHod) out.push('This user is limited to their own department. If they asked about the whole college or another department, say that you can show only their own department.');
  if (d.blocked.length) out.push(`Not available to this role (say so politely): ${d.blocked.map((b) => TOPIC_LABEL[b] || b).join(', ')}`);

  if (d.people) out.push(`=== STUDENTS, TEACHERS AND DEPARTMENTS ===\n${peopleText(d.people)}`);

  if (d.courses) {
    const c = d.courses;
    out.push([
      `=== COURSES AND SUBJECTS ===\nTotal active courses: ${c.total}`,
      `Per department and semester:\n${c.perSemester.map((x) => `  ${x.department} ${x.semester}: ${x.courses} courses, ${x.credits} credit hours`).join('\n') || '  none'}`,
      `Courses (${c.list.length} shown of ${c.total}):\n${c.list.map((x) => `  ${x.code} | ${x.title} | ${x.department} | ${x.semester} | sec ${x.section} | ${x.credits} credit hours | teacher ${x.teacher}`).join('\n')}`,
    ].join('\n'));
  }

  if (d.fees) {
    const f = d.fees;
    const filt = [f.filters.semester ? `semester ${f.filters.semester}` : '', f.filters.kinds.length ? `fee type ${f.filters.kinds.join(', ')}` : ''].filter(Boolean).join(', ');
    out.push([
      `=== FEES AND FINANCE${filt ? ` (${filt})` : ''} ===`,
      FEE_BASIS,
      `Total collected: ${money(f.totals.collected)}`,
      `Total pending: ${money(f.totals.pending)} (overdue ${money(f.totals.overdue)}, still open ${money(f.totals.open)}); unpaid fee items: ${f.totals.unpaidItems} (one per student per fee notice); notices not open yet: ${f.totals.notOpen}`,
      `Fee notices counted: ${f.totals.notices}`,
      `Bank transfers waiting for the finance office to verify: ${f.awaiting.payments} payments, ${money(f.awaiting.amount)} (not counted as collected yet)`,
      `By department:\n${f.byDepartment.map((x) => `  ${x.label}: collected ${money(x.collected)}, pending ${money(x.pending)}`).join('\n') || '  none'}`,
      `By semester:\n${f.bySemester.map((x) => `  ${x.label}: collected ${money(x.collected)}, pending ${money(x.pending)}`).join('\n') || '  none'}`,
      `By fee type:\n${f.byType.map((x) => `  ${x.label}: collected ${money(x.collected)}, pending ${money(x.pending)}`).join('\n') || '  none'}`,
      `Fee notices (${f.notices.length} shown of ${f.noticesTotal}):\n${f.notices.map((x) => `  ${x.title} | ${x.type} | ${x.department} ${x.semester} | ${money(x.amount)} | due ${x.due} | ${x.state} | paid by ${x.paidStudents} | unpaid ${x.unpaidStudents} | collected ${money(x.collected)} | pending ${money(x.pending)}`).join('\n')}`,
      f.defaulters ? `Students with unpaid fees (${f.defaulters.rows.length} shown of ${f.defaulters.total}):\n${f.defaulters.rows.map((x) => `  ${x.name} | ${x.roll} | ${x.department} | ${x.semester} | owes ${money(x.owes)} | ${x.items}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  }

  if (d.performance) {
    const p = d.performance;
    out.push([
      `=== ACADEMIC PERFORMANCE${p.semester ? ` (semester ${p.semester})` : ''} ===`,
      'Pass rate and average use PUBLISHED results only. Attendance = present plus approved leave, over all marked records.',
      `By department:\n${p.byDepartment.map((x) => `  ${x.department}: ${x.results} results, ${x.passed} passed, pass rate ${show(x.passRate)}%, average ${show(x.average)}%, attendance ${show(x.attendance)}%`).join('\n') || '  no published results'}`,
      `By semester:\n${p.bySemester.map((x) => `  ${x.department} semester ${x.semester}: ${x.results} results, pass rate ${show(x.passRate)}%, average ${show(x.average)}%`).join('\n') || '  none'}`,
      p.top.length ? `Top results:\n${p.top.map((x) => `  ${x.name} | ${x.roll} | ${x.department} | semester ${x.semester} | ${x.percentage}% | ${x.grade}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'));
  }
  return out.join('\n\n').slice(0, 15000);
};

// Without an AI key the same data is shown directly as tables.
export const reportFallback = (d) => {
  const out = [`**Scope:** ${d.scopeLabel}`, ''];
  if (d.blocked.length) out.push(`_Your role cannot see: ${d.blocked.map((b) => TOPIC_LABEL[b] || b).join(', ')}._`, '');

  if (d.people) {
    out.push(peopleFallback(d.people).split('\n').filter((l) => !l.startsWith('_The AI model is not switched on')).join('\n'), '');
  }
  if (d.courses) {
    const c = d.courses;
    out.push(`### Courses and subjects (${c.total} active)`);
    if (c.perSemester.length) out.push(table(['Department', 'Semester', 'Courses', 'Credit hours'], c.perSemester.map((x) => [x.department, x.semester, x.courses, x.credits])), '');
    if (c.list.length) out.push(table(['Code', 'Subject', 'Dept', 'Semester', 'Section', 'Credit hrs', 'Teacher'], c.list.map((x) => [x.code, x.title, x.department, x.semester, x.section, x.credits, x.teacher])), '');
  }
  if (d.fees) {
    const f = d.fees;
    out.push('### Fees and finance',
      `- **Total collected:** ${money(f.totals.collected)}`,
      `- **Total pending:** ${money(f.totals.pending)} (overdue ${money(f.totals.overdue)}, still open ${money(f.totals.open)})`,
      `- **Bank transfers waiting for verification:** ${f.awaiting.payments} (${money(f.awaiting.amount)})`,
      `- _${FEE_BASIS}_`, '');
    if (f.byDepartment.length) out.push('**By department**', table(['Department', 'Collected', 'Pending'], f.byDepartment.map((x) => [x.label, money(x.collected), money(x.pending)])), '');
    if (f.bySemester.length) out.push('**By semester**', table(['Semester', 'Collected', 'Pending'], f.bySemester.map((x) => [x.label, money(x.collected), money(x.pending)])), '');
    if (f.byType.length) out.push('**By fee type**', table(['Fee type', 'Collected', 'Pending'], f.byType.map((x) => [x.label, money(x.collected), money(x.pending)])), '');
    if (f.notices.length) out.push('**Fee notices**', table(['Notice', 'Type', 'Dept / semester', 'Amount', 'Due', 'State', 'Paid by', 'Unpaid', 'Collected', 'Pending'],
      f.notices.map((x) => [x.title, x.type, `${x.department} ${x.semester}`, money(x.amount), x.due, x.state, x.paidStudents, x.unpaidStudents, money(x.collected), money(x.pending)])), '');
    if (f.defaulters) out.push(`**Students with unpaid fees** (${f.defaulters.rows.length} shown of ${f.defaulters.total})`, table(['Name', 'Roll no', 'Dept', 'Semester', 'Owes', 'Fees'], f.defaulters.rows.map((x) => [x.name, x.roll, x.department, x.semester, money(x.owes), x.items])), '');
  }
  if (d.performance) {
    const p = d.performance;
    out.push(`### Academic performance${p.semester ? ` (semester ${p.semester})` : ''}`);
    out.push(p.byDepartment.length ? table(['Department', 'Results', 'Passed', 'Pass rate', 'Average', 'Attendance'], p.byDepartment.map((x) => [x.department, x.results, x.passed, `${show(x.passRate)}%`, `${show(x.average)}%`, `${show(x.attendance)}%`])) : '- No published results yet.', '');
    if (p.bySemester.length) out.push('**By semester**', table(['Department', 'Semester', 'Results', 'Pass rate', 'Average'], p.bySemester.map((x) => [x.department, x.semester, x.results, `${show(x.passRate)}%`, `${show(x.average)}%`])), '');
    if (p.top.length) out.push('**Top results**', table(['Name', 'Roll no', 'Dept', 'Semester', '%', 'Grade'], p.top.map((x) => [x.name, x.roll, x.department, x.semester, x.percentage, x.grade])), '');
  }
  out.push('_The AI model is not switched on, so this is a direct report from the database._');
  return out.join('\n');
};
