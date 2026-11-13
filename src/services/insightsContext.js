import Department from '../models/Department.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import Attendance from '../models/Attendance.js';
import Result from '../models/Result.js';
import Payment from '../models/Payment.js';
import FeeNotice from '../models/FeeNotice.js';
import Semester from '../models/Semester.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError } from '../utils/apiHelpers.js';
import { ROLES, COURSE_STATUS, PAYMENT_STATUS, FEE_NOTICE_STATUS, RESULT_STATUS, ENROLLMENT_STATUS } from '../config/constants.js';
import { semesterProfiles } from './feeService.js';
import { loadPeople, peopleText, peopleFallback } from './peopleContext.js';
import { scopeOf, matchDepartments, parseIntent } from './assistantScope.js';

// ==========================================================================================================
// Live statistics and reports for the AI assistant (read-only, straight from the database, nothing is guessed).
//
// ONE entry point, buildInsights(user, question, ...). What it returns depends on the role (see assistantScope.js):
//   HOD (department chatbot) : only the HOD's own department. Data of another department is never loaded, so it can never leak.
//   finance office           : fee and payment reports of the whole college. No academic data is loaded.
//   principal                : everything, college-wide.
//
// Fee rules are the same as the Finance Overview page (controllers/feeController.js):
//   collected   = money of payments with status "paid"
//   outstanding = for every published or closed fee notice: unpaid students x the notice amount
// ==========================================================================================================

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : 'n/a');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
// Practical fees count as examination money (same as the finance reports).
const reportType = (t) => (t === 'practical' ? 'examination' : ['examination', 'promotion'].includes(t) ? t : 'other');
const TYPE_LABEL = { examination: 'Examination (incl. practical)', promotion: 'Promotion', other: 'Other' };
const MAX_TEXT = 14000;
const CUT = '\n\n[DATA CUT: more rows exist than are shown here. Tell the user the list is incomplete and ask them to narrow the question by department or semester.]';

export const loadDepartments = () => Department.find({}).populate('hod', 'name').select('name code hod status').sort({ name: 1 }).lean();

// ---------- academic statistics ----------
const loadAcademic = async ({ targets, intent, semester, multi }) => {
  const ids = targets.map((d) => d._id);
  const dm = { $in: ids };
  const code = new Map(targets.map((d) => [String(d._id), d.code]));
  const out = [];

  const [stu, tch, crs] = await Promise.all([
    StudentProfile.aggregate([{ $match: { department: dm } }, { $group: { _id: { d: '$department', s: '$semester', st: '$status' }, n: { $sum: 1 } } }]),
    User.aggregate([{ $match: { department: dm, role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true } }, { $group: { _id: { d: '$department', r: '$role' }, n: { $sum: 1 } } }]),
    Course.aggregate([{ $match: { department: dm, status: COURSE_STATUS.ACTIVE } }, { $group: { _id: { d: '$department', s: '$semester' }, n: { $sum: 1 } } }]),
  ]);
  const semIds = [...new Set([...stu.map((x) => x._id.s), ...crs.map((x) => x._id.s)].filter(Boolean).map(String))];
  const semInfo = new Map((await Semester.find({ _id: { $in: semIds } }).select('name number').lean()).map((s) => [String(s._id), s]));
  const inSem = (s) => !semester || semInfo.get(String(s))?.number === semester;

  // department table
  const rows = targets.map((d) => {
    const id = String(d._id);
    const n = (st) => stu.filter((x) => String(x._id.d) === id && x._id.st === st).reduce((t, x) => t + x.n, 0);
    const t = (r) => tch.filter((x) => String(x._id.d) === id && x._id.r === r).reduce((s, x) => s + x.n, 0);
    const c = crs.filter((x) => String(x._id.d) === id).reduce((s, x) => s + x.n, 0);
    return { name: `${d.name} (${d.code})`, hod: d.hod?.name || 'none', active: n('active'), suspended: n('suspended'), graduated: n('graduated'), withdrawn: n('withdrawn'), teachers: t(ROLES.TEACHER), hods: t(ROLES.HOD), courses: c };
  });
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  const body = rows.map((r) => [r.name, r.hod, r.active, r.suspended, r.graduated, r.withdrawn, r.teachers, r.hods, r.courses]);
  if (multi) body.push(['COLLEGE TOTAL', '', sum('active'), sum('suspended'), sum('graduated'), sum('withdrawn'), sum('teachers'), sum('hods'), sum('courses')]);
  out.push('## Departments: students, teachers, courses', table(['Department', 'HOD', 'Active students', 'Suspended', 'Graduated', 'Withdrawn', 'Teachers', 'HODs', 'Active courses'], body));

  // students per semester
  const perSem = new Map();
  for (const x of stu.filter((r) => r._id.st === 'active' && inSem(r._id.s))) {
    const key = `${x._id.d}|${x._id.s}`;
    perSem.set(key, (perSem.get(key) || 0) + x.n);
  }
  const semRows = [...perSem.entries()].map(([k, n]) => {
    const [d, s] = k.split('|');
    const info = semInfo.get(s);
    return [code.get(d), info?.name || 'no semester', info?.number ?? 99, n, crs.filter((c) => String(c._id.d) === d && String(c._id.s) === s).reduce((t, c) => t + c.n, 0)];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[2] - b[2]).slice(0, 120);
  out.push(`## Active students and active courses per semester${semester ? ` (semester ${semester} only)` : ''}`, semRows.length ? table(['Dept', 'Semester', 'Semester no', 'Active students', 'Active courses'], semRows) : 'No active students in this selection.');

  // course list
  if (intent.courses) {
    const filter = { department: dm, status: COURSE_STATUS.ACTIVE };
    if (semester) filter.semester = { $in: await Semester.find({ department: dm, number: semester }).distinct('_id') };
    const courses = await Course.find(filter).populate('teacher', 'name').populate('semester', 'name number').select('code title section creditHours teacher semester department').limit(150).lean();
    const enr = await CourseEnrollment.aggregate([{ $match: { course: { $in: courses.map((c) => c._id) }, status: ENROLLMENT_STATUS.ENROLLED } }, { $group: { _id: '$course', n: { $sum: 1 } } }]);
    const en = new Map(enr.map((e) => [String(e._id), e.n]));
    courses.sort((a, b) => String(code.get(String(a.department))).localeCompare(String(code.get(String(b.department)))) || (a.semester?.number || 0) - (b.semester?.number || 0) || a.code.localeCompare(b.code));
    out.push(`## Courses and subjects (${courses.length}${courses.length === 150 ? ', first 150' : ''})`,
      table(['Dept', 'Semester', 'Code', 'Subject', 'Section', 'Credit hrs', 'Teacher', 'Enrolled students'], courses.map((c) => [code.get(String(c.department)), c.semester?.name, c.code, c.title, c.section, c.creditHours, c.teacher?.name || 'not assigned', en.get(String(c._id)) || 0])));
  }

  // attendance
  if (intent.attendance || intent.report) {
    const att = await Attendance.aggregate([
      { $match: { department: dm } }, { $unwind: '$records' },
      { $group: { _id: '$department', total: { $sum: 1 }, present: { $sum: { $cond: [{ $eq: ['$records.status', 'present'] }, 1, 0] } }, leave: { $sum: { $cond: [{ $eq: ['$records.status', 'leave'] }, 1, 0] } }, absent: { $sum: { $cond: [{ $eq: ['$records.status', 'absent'] }, 1, 0] } } } },
    ]);
    out.push('## Attendance by department (all marked student-days; approved leave counts as attended)',
      att.length ? table(['Department', 'Marked', 'Present', 'Leave', 'Absent', 'Attendance %'], att.map((a) => [code.get(String(a._id)), a.total, a.present, a.leave, a.absent, pct(a.present + a.leave, a.total)])) : 'No attendance has been marked yet.');
  }

  // academic performance
  if (intent.performance || intent.report || intent.top || intent.low) {
    const match = { department: dm, status: RESULT_STATUS.PUBLISHED };
    if (semester) match.semesterNumber = semester;
    const res = await Result.aggregate([{ $match: match }, { $group: { _id: { d: '$department', n: '$semesterNumber' }, total: { $sum: 1 }, passed: { $sum: { $cond: [{ $eq: ['$outcome', 'pass'] }, 1, 0] } }, avg: { $avg: '$percentage' } } }]);
    const byDept = new Map();
    for (const r of res) {
      const k = String(r._id.d);
      const e = byDept.get(k) || { total: 0, passed: 0, sumPct: 0 };
      e.total += r.total; e.passed += r.passed; e.sumPct += r.avg * r.total;
      byDept.set(k, e);
    }
    out.push(`## Published results${semester ? ` (semester ${semester})` : ''}: pass rate and average percentage`,
      byDept.size ? table(['Department', 'Results', 'Passed', 'Failed', 'Pass rate', 'Average %'], [...byDept.entries()].map(([d, e]) => [code.get(d), e.total, e.passed, e.total - e.passed, pct(e.passed, e.total), (e.sumPct / e.total).toFixed(1)])) : 'No published results yet.');
    if (res.length > byDept.size || semester) {
      out.push('By semester number:', table(['Dept', 'Semester no', 'Results', 'Pass rate', 'Average %'], res.sort((a, b) => a._id.n - b._id.n).slice(0, 80).map((r) => [code.get(String(r._id.d)), r._id.n, r.total, pct(r.passed, r.total), r.avg.toFixed(1)])));
    }
    if (intent.top || intent.low) {
      const list = await Result.find(match).sort({ percentage: intent.low && !intent.top ? 1 : -1 }).limit(5).populate('student', 'name').populate('examination', 'name').lean();
      const rolls = new Map((await StudentProfile.find({ user: { $in: list.map((r) => r.student?._id) } }).select('user rollNumber').lean()).map((p) => [String(p.user), p.rollNumber]));
      out.push(intent.low && !intent.top ? '### Lowest 5 published results' : '### Top 5 published results',
        table(['Student', 'Roll no', 'Dept', 'Semester no', 'Exam', '%', 'Grade', 'Outcome'], list.map((r) => [r.student?.name, rolls.get(String(r.student?._id)), code.get(String(r.department)), r.semesterNumber, r.examination?.name, r.percentage, r.grade, r.outcome])));
    }
  }
  return out;
};

// ---------- finance reports ----------
const loadFinance = async ({ targets, wholeCollege, intent, semester, currency }) => {
  const money = (n) => `${currency} ${Math.round(Number(n || 0)).toLocaleString('en-US')}`;
  const deptFilter = wholeCollege ? {} : { department: { $in: targets.map((d) => d._id) } };
  const out = [];

  const [byMethod, refunded, awaiting, perNotice, notices] = await Promise.all([
    Payment.aggregate([{ $match: { status: PAYMENT_STATUS.PAID, ...deptFilter } }, { $group: { _id: '$method', count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }]),
    Payment.aggregate([{ $match: { status: PAYMENT_STATUS.REFUNDED, ...deptFilter } }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }]),
    Payment.aggregate([{ $match: { status: PAYMENT_STATUS.PENDING, method: 'bank', ...deptFilter } }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }]),
    Payment.aggregate([{ $match: { status: PAYMENT_STATUS.PAID, ...deptFilter } }, { $unwind: '$items' }, { $group: { _id: '$items.notice', count: { $sum: 1 }, collected: { $sum: '$items.total' }, late: { $sum: '$items.lateFee' } } }]),
    FeeNotice.find({ status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] }, ...deptFilter }).populate('department', 'name code').populate('semester', 'name number').lean(),
  ]);
  const paidMap = new Map(perNotice.map((p) => [String(p._id), p]));

  // students that owe each notice (same rule as the Finance Overview page); one lookup per semester
  const memo = new Map();
  const studentsOf = (n) => {
    const k = String(n.semester._id);
    if (!memo.has(k)) memo.set(k, semesterProfiles(n.semester._id));
    return memo.get(k).then((list) => list.filter((p) => String(p.department) === String(n.department._id)).length);
  };
  const picked = notices.filter((n) => n.semester && n.department && (!semester || n.semester.number === semester));
  const rows = [];
  for (const n of picked) {
    const students = await studentsOf(n);
    const p = paidMap.get(String(n._id)) || { count: 0, collected: 0, late: 0 };
    const unpaid = Math.max(students - p.count, 0);
    rows.push({ id: String(n._id), title: n.title, type: reportType(n.feeType), dept: n.department.code, deptName: n.department.name, semester: n.semester.name, semNo: n.semester.number, amount: n.amount, due: day(n.dueDate), status: n.status, students, paid: p.count, unpaid, collected: p.collected, late: p.late, outstanding: unpaid * n.amount });
  }
  const total = (list, k) => list.reduce((t, r) => t + r[k], 0);

  // headline
  const allCollected = byMethod.reduce((t, m) => t + m.amount, 0);
  const label = { gateway: 'online', manual: 'office', bank: 'bank transfer' };
  const headline = [
    semester ? `Figures for semester ${semester} only (from its fee notices).` : '',
    `Total fees collected${semester ? ' (this semester)' : ' (all paid payments)'}: ${money(semester ? total(rows, 'collected') : allCollected)}`,
    `Total outstanding (pending, unpaid by students): ${money(total(rows, 'outstanding'))}`,
    !semester ? `Collected by channel: ${byMethod.map((m) => `${label[m._id] || m._id} ${money(m.amount)} (${m.count} payments)`).join('; ') || 'none'}` : '',
    `Late fees included in the collected amount: ${money(total(rows, 'late'))}`,
    !semester ? `Refunded: ${money(refunded[0]?.amount)} (${refunded[0]?.count || 0} payments)` : '',
    !semester ? `Bank transfers waiting for the finance office to verify (NOT yet collected): ${money(awaiting[0]?.amount)} (${awaiting[0]?.count || 0} transfers)` : '',
    `Rule: outstanding = unpaid students x the notice fee for every published or closed fee notice. Practical-fee extras and late fees are not part of outstanding. This is the same rule as the Finance Overview page.`,
  ].filter(Boolean);
  out.push(`## Fee summary ${wholeCollege ? '(whole college)' : `(${targets.map((d) => d.code).join(', ')})`}`, headline.map((l) => `- ${l}`).join('\n'));

  // by fee type
  const types = ['examination', 'promotion', 'other'];
  out.push('## Fees by type', table(['Fee type', 'Collected', 'Outstanding', 'Payments received', 'Students not paid'], types.map((t) => {
    const r = rows.filter((x) => x.type === t);
    return [TYPE_LABEL[t], money(total(r, 'collected')), money(total(r, 'outstanding')), total(r, 'paid'), total(r, 'unpaid')];
  })));

  // by department
  const depts = [...new Set(rows.map((r) => r.dept))].sort();
  if (depts.length > 1 || intent.departments || intent.report) {
    out.push('## Fees by department', table(['Department', 'Examination collected', 'Promotion collected', 'Other collected', 'Total collected', 'Outstanding'], depts.map((d) => {
      const r = rows.filter((x) => x.dept === d);
      const c = (t) => total(r.filter((x) => x.type === t), 'collected');
      return [`${r[0].deptName} (${d})`, money(c('examination')), money(c('promotion')), money(c('other')), money(total(r, 'collected')), money(total(r, 'outstanding'))];
    })));
  }

  // by semester
  if (intent.semesterWise || semester || depts.length === 1 || intent.report) {
    const key = (r) => `${r.dept}|${r.semNo}|${r.semester}`;
    const groups = [...new Set(rows.map(key))].sort((a, b) => a.split('|')[0].localeCompare(b.split('|')[0]) || Number(a.split('|')[1]) - Number(b.split('|')[1]));
    out.push('## Fees by semester', table(['Dept', 'Semester', 'Collected', 'Outstanding', 'Payments received', 'Students not paid'], groups.slice(0, 80).map((g) => {
      const r = rows.filter((x) => key(x) === g);
      return [r[0].dept, r[0].semester, money(total(r, 'collected')), money(total(r, 'outstanding')), total(r, 'paid'), total(r, 'unpaid')];
    })));
  }

  // fee notices
  if (depts.length === 1 || semester || intent.examFee || intent.promotionFee || intent.report) {
    const list = rows.filter((r) => (!intent.promotionFee || intent.examFee || r.type === 'promotion') && (!intent.examFee || intent.promotionFee || r.type === 'examination')).sort((a, b) => a.dept.localeCompare(b.dept) || a.semNo - b.semNo).slice(0, 60);
    out.push(`## Fee notices (${list.length}${list.length === 60 ? ', first 60' : ''})`, list.length ? table(['Dept', 'Semester', 'Fee', 'Type', 'Fee amount', 'Due', 'Status', 'Students', 'Paid', 'Unpaid', 'Collected', 'Outstanding'], list.map((r) => [r.dept, r.semester, r.title, TYPE_LABEL[r.type], money(r.amount), r.due, r.status, r.students, r.paid, r.unpaid, money(r.collected), money(r.outstanding)])) : 'No fee notice matches.');
  }
  out.push('For the fee record of ONE student, the user should type the roll number, for example "fees of CS-S1-03".');
  return out;
};

// ---------- entry point ----------
// specific = the question names a person, e-mail or course code (the records search answers those).
export const buildInsights = async (user, message, previous = '', departments = [], { specific = false } = {}) => {
  const scope = scopeOf(user);
  if (!scope) throw ApiError.forbidden('The assistant is not available for your account');
  const empty = () => ({ text: '', fallback: '', hasContent: false, access: '', audit: {} });

  const own = parseIntent(message);
  const short = String(message).trim().split(/\s+/).length <= 8;
  const intent = own.any ? own : parseIntent(`${previous} ${message}`);
  if (specific && !intent.strong) return empty(); // one person: the records search answers it
  const semester = own.semester ?? (short ? parseIntent(previous).semester : null);

  const mentionedNow = matchDepartments(message, departments);
  const mentioned = mentionedNow.length ? mentionedNow : short ? matchDepartments(previous, departments) : [];
  const active = departments.filter((d) => d.status === 'active');
  const notes = [];
  let targets;
  let suppress = false;
  let access;

  if (!scope.collegeWide) {
    const mine = departments.find((d) => String(d._id) === scope.departmentId);
    if (!mine) return empty();
    targets = [mine];
    access = `You are the assistant of the ${mine.name} (${mine.code}) department. You may share information about ${mine.name} ONLY. For any other department, or for the whole college, say that you can only share ${mine.name} information, and give no figure, name or detail about anything else.`;
    const foreign = mentioned.filter((d) => String(d._id) !== scope.departmentId);
    if (foreign.length) {
      notes.push(`ACCESS: the user asked about ${foreign.map((d) => d.name).join(', ')}, which is outside ${mine.name}. No data about it is supplied and none may be given.`);
      if (!mentioned.some((d) => String(d._id) === scope.departmentId)) suppress = true;
    } else if (intent.college) {
      notes.push(`ACCESS: the user asked about the whole college. Only ${mine.name} data is supplied; say so.`);
    }
  } else {
    targets = mentioned.length ? mentioned : active;
    access = scope.role === ROLES.FINANCE_OFFICER
      ? 'You are the assistant of the Finance office. You may share the financial information of the whole college: fees collected and pending, examination and promotion fees, department-wise and semester-wise fee reports, and the fee record of any student. You must NOT share attendance, marks, results, teachers, courses or other academic information.'
      : 'You are the assistant of the Principal. You may share any information of the whole college that is in the data supplied.';
    if (!scope.academic && (intent.teachers || intent.courses || intent.attendance || intent.performance || intent.peopleList || intent.top || intent.low)) {
      notes.push('ACCESS: the user is the finance office and may NOT get academic information (teachers, courses, attendance, marks, results, student lists). Say so briefly and offer fee information instead.');
    }
  }

  const pureFinance = intent.wantsFinance && !(intent.students || intent.teachers || intent.courses || intent.performance || intent.attendance || intent.top || intent.low);
  const wantAcademic = scope.academic && !suppress && !pureFinance;
  const wantFinance = scope.finance && !suppress && (intent.wantsFinance || !scope.academic || (intent.report && scope.collegeWide));

  const md = [];
  const fb = [];
  const used = [];
  if (wantAcademic) {
    const sec = await loadAcademic({ targets, intent, semester, multi: targets.length > 1 });
    md.push(...sec); fb.push(...sec); used.push('academic');
    if (intent.peopleList) {
      const people = await loadPeople(user, `${intent.any && own.any ? '' : `${previous} `}${message}`);
      md.push(`## People\n${peopleText(people)}`);
      fb.push(peopleFallback(people).split('\n').filter((l) => !l.startsWith('_The AI model is not switched on')).join('\n'));
      used.push('people');
    }
  }
  if (wantFinance) {
    const currency = (await UniversitySettings.getSettings()).feePolicy?.currency || 'PKR';
    const sec = await loadFinance({ targets, wholeCollege: scope.collegeWide && !mentioned.length, intent, semester, currency });
    md.push(...sec); fb.push(...sec); used.push('finance');
  }

  const clip = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}${CUT}` : s);
  const hasContent = md.length > 0;
  const text = clip([...notes, ...md].join('\n\n'));
  let fallback = fb.join('\n\n');
  if (notes.length) fallback = `${notes.map((n) => `_${n.replace(/^ACCESS: /, '')}_`).join('\n')}\n\n${fallback}`.trim();
  if (suppress) fallback = `I can only share information about **${targets[0].name}**. ${fallback}`.trim();
  if (hasContent) fallback = `${clip(fallback)}\n\n_The AI model is not switched on, so this is a direct answer from the database. Add an AI key on the server to ask free-form questions._`;
  return {
    text, fallback, hasContent: hasContent || notes.length > 0, access,
    audit: { scope: scope.role, departments: scope.collegeWide && !mentioned.length ? 'all' : targets.map((d) => d.code), sections: used, semester, blocked: suppress || notes.some((n) => n.includes('outside')) },
  };
};
