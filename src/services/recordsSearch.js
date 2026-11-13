import mongoose from 'mongoose';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import Attendance from '../models/Attendance.js';
import Payment from '../models/Payment.js';
import FeeNotice from '../models/FeeNotice.js';
import Result from '../models/Result.js';
import ExaminationAdmission from '../models/ExaminationAdmission.js';
import UniversitySettings from '../models/UniversitySettings.js';
import TimetableSlot from '../models/TimetableSlot.js';
import Department from '../models/Department.js';
import Semester from '../models/Semester.js';
import { ROLES, ENROLLMENT_STATUS, COURSE_STATUS, PAYMENT_STATUS, FEE_NOTICE_STATUS, RESULT_STATUS, STUDENT_STATUS } from '../config/constants.js';

// ==========================================================================================================
// "Search records": the principal, the HODs and the finance office type a roll number (or a name, an email, a course code)
// and get the student, teacher or course with attendance, fees and examinations. The data is read from the database by this
// file, so nothing is guessed. An HOD only reaches their own department; the principal and the finance office reach all.
// To limit what a role may see, change FACETS_BY_ROLE (one line per role).
// ==========================================================================================================

// Who can see what (one line per role, change it here):
//   principal      : the whole college. Every kind of information, and the college overview.
//   HOD            : ONLY their own department: its students, teachers and courses (attendance, fees, promotion, exams).
//   finance office : student FEES and PROMOTION fees only. No attendance, no marks, no teachers or courses.
const ALL_FACETS = ['attendance', 'fees', 'promotion', 'exam', 'courses'];
export const FACETS_BY_ROLE = {
  [ROLES.UNIVERSITY_HEAD]: ALL_FACETS,
  [ROLES.HOD]: ALL_FACETS,
  [ROLES.FINANCE_OFFICER]: ['fees', 'promotion'],
};
const SEES_STAFF_AND_COURSES = new Set([ROLES.UNIVERSITY_HEAD, ROLES.HOD]); // teachers and courses are searched by these two only

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STOP = new Set(
  `a an and are all about as at be by can do does for from get give has have how i in info information is it me my of on or please show tell that the their them there this to us what when where which who with you your
  find search look details detail record records student students teacher teachers faculty course courses subject subjects roll number no num attendance attend present absent leave fee fees paid payment payments due dues
  exam exams result results marks grade gpa dmc midterm final admission class timetable enrolled status full complete everything promotion promoted
  college university overall overview summary statistics departments department hods principal total collection
  pending collected revenue income unpaid outstanding refund refunded amount money wise report reports count counts list lists each every per by semester semesters sem
  highest lowest top best worst average percentage performance pass passed fail failed rate ratio types type late practical financial finance office
  was were will would could should been being also into than then only just more most less any some many much very new old current latest this year month today`.split(/\s+/)
);

// A roll number or course code has letters AND digits ("CS-S1-03", "21CS045", "CS-4301").
const looksLikeCode = (t) => t.length >= 4 && /\d/.test(t) && /[a-z]/i.test(t);

// Understands the question (pure, unit tested): which codes, emails and names, and which kind of information is wanted.
// When no kind is named ("CS-S1-03"), everything is shown.
// `ignore` = words that are NOT a person's name (the department names and codes, see assistantScope.departmentWords).
export const parseRecordsQuery = (question, ignore = []) => {
  const skip = ignore instanceof Set ? ignore : new Set(ignore);
  const text = String(question || '');
  const lower = text.toLowerCase();
  const emails = [...new Set((text.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g) || []).map((e) => e.toLowerCase()))];
  const plain = text.replace(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g, ' ');
  const tokens = plain.match(/[A-Za-z0-9](?:[A-Za-z0-9_./-]*[A-Za-z0-9])?/g) || [];
  const codes = [...new Set(tokens.filter(looksLikeCode).map((t) => t.toUpperCase()))];
  const names = [...new Set(tokens.filter((t) => /^[a-z]{3,}$/i.test(t) && !STOP.has(t.toLowerCase()) && !skip.has(t.toLowerCase())))];
  const facets = {
    attendance: /attend|present|absent|bunk|leaves?\b/.test(lower),
    fees: /\bfees?\b|paid|payment|dues?\b|challan|receipt|balance|outstanding|unpaid/.test(lower),
    promotion: /promot|next semester|upgrade/.test(lower),
    exam: /exam|result|marks|grade|gpa|dmc|midterm|final|admit|admission/.test(lower),
    courses: /course|subject|class|timetable|enrol/.test(lower),
  };
  const any = Object.values(facets).some(Boolean);
  // A question about the whole college (counts, departments, HODs, collection) rather than one person. Only the principal gets it.
  const college = /\b(college|university|overall|overview|summary|statistics|departments?|hods?|how many|total|collection)\b/.test(lower);
  // Report questions: totals, lists, statistics, money. They are answered from live aggregates of the database.
  const stats = /how many|total|count|number of|statistic|report|overview|summary|\blist\b|\ball (the )?(students|teachers|courses|subjects)|semester[- ]?wise|department[- ]?wise|each department|every department|performance|pass (rate|percentage)/.test(lower);
  const money = /collect|revenue|income|pending|outstanding|unpaid|\bdues?\b|fee report|total fees?|exam(ination)? fees?|promotion fees?|fees? (of|for|in|report)/.test(lower);
  return {
    codes, emails, names, facets, college, stats, money, all: !any,
    wantsTeacher: /\b(teachers?|faculty|sir|madam|lecturers?|professors?)\b/.test(lower),
    wantsList: /\blist\b|\ball (the )?(students|teachers|courses|subjects)|show (me )?(all|every)|names of/.test(lower),
    semesterNumber: semesterNumberOf(lower),
  };
};

// "CS-S1-03" also finds "CS S1 03" and "CSS103": the separators are optional.
export const codeRegex = (code) => new RegExp(`^${code.split(/[^A-Za-z0-9]+/).filter(Boolean).map(esc).join('[-_ /.]*')}$`, 'i');

// present + (approved leave, if the university counts it as present) / all marked days. null when nothing was marked yet.
export const attendancePercent = ({ present = 0, absent = 0, leave = 0 }, leaveCountsAsPresent = true) => {
  const total = present + absent + leave;
  return total ? Math.round(((present + (leaveCountsAsPresent ? leave : 0)) / total) * 100) : null;
};

const asFacets = (role, parsed) => {
  const allowed = FACETS_BY_ROLE[role] || [];
  const wanted = parsed.all ? ALL_FACETS : ALL_FACETS.filter((f) => parsed.facets[f]);
  const set = new Set(wanted.filter((f) => allowed.includes(f)));
  if (set.has('promotion') && allowed.includes('fees')) set.add('fees'); // promotion fees are part of the fee record
  return set;
};

// What searchRecords returns when nothing specific was asked (the question is answered by the statistics instead).
export const emptyRecords = () => ({ students: [], teachers: [], courses: [], notFound: [], outsideScope: 0, parsed: parseRecordsQuery(''), facets: [] });

const money = (n, c = 'PKR') => `${c} ${Number(n || 0).toLocaleString('en-US')}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');

// "semester 3" / "3rd semester" -> 3 (pure)
export const semesterNumberOf = (q) => {
  const m = /semester\s*(?:no\.?\s*)?(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s*semester/i.exec(String(q || ''));
  const n = m ? Number(m[1] || m[2]) : null;
  return n >= 1 && n <= 12 ? n : null;
};

// Departments named in the question, by code (as a whole word) or by name. Roll numbers and course codes are removed first,
// so "CS-S1-03" is never read as "the CS department". (pure)
export const matchDepartments = (question, departments, codes = []) => {
  let text = String(question || '').toLowerCase();
  for (const c of codes) text = text.split(c.toLowerCase()).join(' ');
  const q = ` ${text.replace(/[^a-z0-9]+/g, ' ')} `;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return departments.filter((d) => (d.code && q.includes(` ${norm(d.code)} `)) || (d.name && q.includes(` ${norm(d.name)} `)));
};

// Which departments may this user look at? An HOD ONLY their own, whatever they ask (asking for another one is refused and
// reported). The principal and the finance office may look at any department or at the whole college (ids = null). (pure)
export const scopeDepartments = ({ role, ownDepartment, asked }) => {
  if (role === ROLES.HOD) {
    return { ids: [String(ownDepartment)], refused: asked.filter((d) => String(d._id) !== String(ownDepartment)).map((d) => d.name) };
  }
  return { ids: asked.length ? asked.map((d) => String(d._id)) : null, refused: [] };
};

// Fee totals from the notices, what was paid for each, and how many students owe each notice. (pure, unit tested)
//   notices : [{ _id, department, semester, feeType, title, amount }]      paid : Map(noticeId -> { students, collected })
//   eligible: Map(`${department}|${semester}` -> number of active students in that semester)
// Pending = students who have not paid yet x the base fee (late fees and practical fees are not guessed).
export const summarizeFees = ({ notices, paid, eligible }) => {
  const rows = notices.map((n) => {
    const p = paid.get(String(n._id)) || { students: 0, collected: 0 };
    const elig = eligible.get(`${n.department}|${n.semester}`) || 0;
    const pendingStudents = Math.max(elig - p.students, 0);
    return { ...n, eligible: elig, paidStudents: p.students, collected: p.collected, pendingStudents, pendingAmount: pendingStudents * (n.amount || 0) };
  });
  const group = (keyOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const g = m.get(k) || { key: k, collected: 0, pending: 0, pendingStudents: 0 };
      g.collected += r.collected; g.pending += r.pendingAmount; g.pendingStudents += r.pendingStudents;
      m.set(k, g);
    }
    return [...m.values()];
  };
  return {
    rows,
    collected: rows.reduce((t, r) => t + r.collected, 0),
    pending: rows.reduce((t, r) => t + r.pendingAmount, 0),
    byType: group((r) => r.feeType || 'other'),
    byDepartment: group((r) => String(r.department)),
    bySemester: group((r) => `${r.department}|${r.semester}`),
  };
};

// ---------- database part ----------
const studentCard = async (profile, facets, settings) => {
  const uid = profile.user._id;
  const card = {
    id: String(uid), hasPhoto: !!profile.user.photo?.storedName,
    name: profile.user.name, roll: profile.rollNumber, email: profile.user.email, phone: profile.user.phone || '',
    department: profile.department?.name || '', semester: profile.semester?.name || 'not placed', section: profile.section, status: profile.status,
    guardian: [profile.guardianName, profile.guardianPhone].filter(Boolean).join(', '),
  };

  const enrolledIds = await CourseEnrollment.find({ student: uid, status: ENROLLMENT_STATUS.ENROLLED }).distinct('course');
  const courses = await Course.find({ _id: { $in: enrolledIds }, status: COURSE_STATUS.ACTIVE }).populate('teacher', 'name').select('code title section teacher creditHours').lean();
  if (facets.has('courses')) {
    card.courses = courses.map((c) => ({ code: c.code, title: c.title, section: c.section, teacher: c.teacher?.name || 'not assigned', creditHours: c.creditHours }));
  }

  if (facets.has('attendance')) {
    const rows = await Attendance.aggregate([
      { $match: { course: { $in: enrolledIds } } },
      { $unwind: '$records' },
      { $match: { 'records.student': uid } },
      { $group: { _id: { course: '$course', status: '$records.status' }, n: { $sum: 1 } } },
    ]);
    const leaveOk = settings.attendanceRules?.allowApprovedLeaveAsPresent !== false;
    card.attendance = courses.map((c) => {
      const mine = rows.filter((r) => String(r._id.course) === String(c._id));
      const n = (s) => mine.filter((r) => r._id.status === s).reduce((t, r) => t + r.n, 0);
      const present = n('present');
      const absent = n('absent');
      const leave = mine.reduce((t, r) => t + r.n, 0) - present - absent;
      return { code: c.code, title: c.title, present, absent, leave, percent: attendancePercent({ present, absent, leave }, leaveOk) };
    });
    const marked = card.attendance.filter((a) => a.percent !== null);
    card.attendanceAverage = marked.length ? Math.round(marked.reduce((t, a) => t + a.percent, 0) / marked.length) : null;
    card.attendanceRequired = settings.admissionRules?.minAttendancePercentage ?? null;
  }

  if (facets.has('fees')) {
    const [paidIds, paidRows, notices] = await Promise.all([
      Payment.distinct('items.notice', { student: uid, status: PAYMENT_STATUS.PAID }),
      Payment.find({ student: uid, status: PAYMENT_STATUS.PAID }).sort({ paidAt: -1 }).limit(8).select('totalAmount currency method receiptNumber paidAt').lean(),
      profile.semester
        ? FeeNotice.find({ department: profile.department?._id, semester: profile.semester._id, status: FEE_NOTICE_STATUS.PUBLISHED }).select('title amount dueDate feeType').lean()
        : [],
    ]);
    const paid = new Set(paidIds.map(String));
    card.fees = {
      outstanding: notices.filter((n) => !paid.has(String(n._id))).map((n) => ({ title: n.title, amount: n.amount, due: day(n.dueDate) })),
      payments: paidRows.map((p) => ({ amount: p.totalAmount, currency: p.currency, method: p.method, receipt: p.receiptNumber, date: day(p.paidAt) })),
    };
  }

  if (facets.has('promotion')) {
    // Promotion fees of the student's CURRENT semester: which are paid and which are still due.
    const [paidIds, notices] = await Promise.all([
      Payment.distinct('items.notice', { student: uid, status: PAYMENT_STATUS.PAID }),
      profile.semester
        ? FeeNotice.find({ department: profile.department?._id, semester: profile.semester._id, feeType: 'promotion', status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] } }).select('title amount dueDate').lean()
        : [],
    ]);
    const paid = new Set(paidIds.map(String));
    card.promotion = { semester: card.semester, fees: notices.map((n) => ({ title: n.title, amount: n.amount, due: day(n.dueDate), paid: paid.has(String(n._id)) })) };
  }

  if (facets.has('exam')) {
    const [results, admissions] = await Promise.all([
      Result.find({ student: uid, status: RESULT_STATUS.PUBLISHED }).populate('examination').sort({ publishedAt: -1 }).limit(8).lean(),
      ExaminationAdmission.find({ student: uid }).populate('examination').sort({ requestedAt: -1 }).limit(6).lean(),
    ]);
    const exName = (e) => e?.title || e?.name || e?.type || 'Examination';
    card.exams = {
      results: results.map((r) => ({ exam: exName(r.examination), semester: r.semesterNumber, percentage: r.percentage, grade: r.grade, outcome: r.outcome, total: `${r.totalObtained}/${r.totalMax}` })),
      admissions: admissions.map((a) => ({ exam: exName(a.examination), status: a.status, reason: a.reason || '' })),
    };
  }
  return card;
};

// Finds what the question is about, inside the role's reach. user must be the principal, an HOD or the finance office.
export const searchRecords = async (user, question, opts = {}) => {
  const parsed = parseRecordsQuery(question, opts.ignore);
  const facets = asFacets(user.role, parsed);
  const hodOnly = user.role === ROLES.HOD ? { department: user.department } : {};
  const settings = await UniversitySettings.getSettings();
  const data = { students: [], teachers: [], courses: [], notFound: [], outsideScope: 0, refused: [], finance: null, departments: null, parsed, facets: [...facets] };

  // students: by roll number, e-mail, or name
  const rollRx = parsed.codes.map(codeRegex);
  const nameRx = parsed.names.length ? new RegExp(parsed.names.map(esc).join('|'), 'i') : null;
  const byName = !rollRx.length && !parsed.emails.length && nameRx && !parsed.wantsTeacher
    ? (await User.find({ role: ROLES.STUDENT, isActive: true, name: nameRx }).distinct('_id')).slice(0, 8)
    : [];
  const byEmail = parsed.emails.length ? await User.find({ role: ROLES.STUDENT, email: { $in: parsed.emails } }).distinct('_id') : [];
  const or = [...rollRx.map((rx) => ({ rollNumber: rx })), ...(byName.length ? [{ user: { $in: byName } }] : []), ...(byEmail.length ? [{ user: { $in: byEmail } }] : [])];
  if (or.length) {
    const all = await StudentProfile.find({ $or: or }).limit(8)
      .populate('user', 'name email phone photo').populate('department', 'name code').populate('semester', 'name').lean();
    const inScope = all.filter((p) => !hodOnly.department || String(p.department?._id) === String(hodOnly.department));
    data.outsideScope = all.length - inScope.length; // found, but in another department (an HOD never sees them)
    for (const p of inScope) data.students.push(await studentCard(p, facets, settings));
  }

  // teachers: by name or e-mail (an HOD: own department, including teachers linked to it)
  if (SEES_STAFF_AND_COURSES.has(user.role) && (parsed.wantsTeacher || (!or.length && nameRx)) && (nameRx || parsed.emails.length)) {
    const filter = { role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true, $or: [...(nameRx ? [{ name: nameRx }] : []), ...(parsed.emails.length ? [{ email: { $in: parsed.emails } }] : [])] };
    if (hodOnly.department) filter.$and = [{ $or: [{ department: hodOnly.department }, { extraDepartments: hodOnly.department }] }];
    const people = await User.find(filter).limit(6).populate('department', 'code name').select('name email phone qualification role photo department').lean();
    for (const t of people) {
      const mine = await Course.find({ teacher: t._id, status: COURSE_STATUS.ACTIVE }).populate('semester', 'name').select('code title section creditHours semester').lean();
      const weekly = await TimetableSlot.countDocuments({ teacher: t._id });
      data.teachers.push({
        id: String(t._id), hasPhoto: !!t.photo?.storedName, name: t.name, role: t.role === ROLES.HOD ? 'HOD' : 'Teacher', department: t.department?.name || '', email: t.email, phone: t.phone || '',
        qualification: t.qualification || '', weeklyClasses: weekly, creditHours: mine.reduce((n, c) => n + (c.creditHours || 0), 0),
        courses: mine.map((c) => `${c.code} ${c.title} (${c.semester?.name || ''}, sec ${c.section})`),
      });
    }
  }

  // courses: by code (principal and HODs only; an HOD only their own department)
  if (SEES_STAFF_AND_COURSES.has(user.role) && rollRx.length) {
    const found = await Course.find({ code: { $in: rollRx }, ...hodOnly }).limit(6).populate('teacher', 'name').populate('semester', 'name').populate('department', 'name').lean();
    for (const c of found) {
      data.courses.push({
        code: c.code, title: c.title, department: c.department?.name || '', semester: c.semester?.name || '', section: c.section, creditHours: c.creditHours, status: c.status,
        teacher: c.teacher?.name || 'not assigned', students: await CourseEnrollment.countDocuments({ course: c._id, status: ENROLLMENT_STATUS.ENROLLED }),
        contents: (c.outline || '').slice(0, 600),
      });
    }
  }

  // ----- reports: totals, statistics and money, from live aggregates -----
  // HOD: only their own department (another department is refused). Finance: money, whole college or any department.
  // Principal: everything, whole college or any department.
  const noPerson = !parsed.codes.length && !parsed.emails.length;
  const found = data.students.length || data.teachers.length || data.courses.length;
  const asked = matchDepartments(question, await Department.find({}).select('name code').lean(), parsed.codes);
  const scope = scopeDepartments({ role: user.role, ownDepartment: user.department, asked });
  data.refused = scope.refused;
  const wantsFinance = noPerson && (parsed.money || (user.role === ROLES.FINANCE_OFFICER && !found));
  const wantsDept = noPerson && SEES_STAFF_AND_COURSES.has(user.role) && (parsed.stats || parsed.college || asked.length > 0 || (!found && !wantsFinance));
  if (wantsFinance) data.finance = await loadFeeReport({ deptIds: scope.ids, semesterNumber: parsed.semesterNumber, currency: settings.feePolicy?.currency || 'PKR' });
  if (wantsDept) data.departments = await loadDepartmentReport({ deptIds: scope.ids, semesterNumber: parsed.semesterNumber, withLists: parsed.wantsList });

  if (!found && !data.finance && !data.departments && !data.refused.length) data.notFound = [...parsed.codes, ...parsed.emails, ...parsed.names].slice(0, 6);
  return data;
};

// ---------- reports: live aggregates of the database ----------
const oid = (id) => new mongoose.Types.ObjectId(String(id));

// Fees of the whole college, or of the chosen departments / semester number. Read straight from the payments and the fee notices.
//   collected = money received for those notices (exam, promotion ...)   pending = unpaid students x base fee
//   revenue   = every verified payment (all methods) of the chosen departments
export const loadFeeReport = async ({ deptIds = null, semesterNumber = null, currency = 'PKR' } = {}) => {
  const dept = deptIds ? { department: { $in: deptIds.map(oid) } } : {};
  const semIds = semesterNumber ? await Semester.find(dept).where('number').equals(semesterNumber).distinct('_id') : null;
  const notices = await FeeNotice.find({
    ...dept,
    status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] },
    ...(semIds ? { semester: { $in: semIds } } : {}),
  }).select('title amount feeType department semester').lean();
  const noticeIds = notices.map((n) => n._id);

  const [paidAgg, eligAgg, depts, sems, methods] = await Promise.all([
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.PAID, 'items.notice': { $in: noticeIds } } },
      { $unwind: '$items' },
      { $match: { 'items.notice': { $in: noticeIds } } },
      { $group: { _id: '$items.notice', students: { $addToSet: '$student' }, collected: { $sum: '$items.total' } } },
    ]),
    StudentProfile.aggregate([
      { $match: { status: STUDENT_STATUS.ACTIVE, semester: { $ne: null }, ...dept } },
      { $group: { _id: { d: '$department', s: '$semester' }, n: { $sum: 1 } } },
    ]),
    Department.find(deptIds ? { _id: { $in: deptIds } } : {}).select('name code').lean(),
    Semester.find(dept).select('name number department').lean(),
    Payment.aggregate([{ $match: { status: PAYMENT_STATUS.PAID, ...dept } }, { $group: { _id: '$method', total: { $sum: '$totalAmount' }, n: { $sum: 1 } } }]),
  ]);

  const s = summarizeFees({
    notices,
    paid: new Map(paidAgg.map((p) => [String(p._id), { students: p.students.length, collected: p.collected }])),
    eligible: new Map(eligAgg.map((e) => [`${e._id.d}|${e._id.s}`, e.n])),
  });
  const deptName = new Map(depts.map((d) => [String(d._id), `${d.name} (${d.code})`]));
  const semName = new Map(sems.map((x) => [String(x._id), x.name]));
  return {
    currency,
    scope: deptIds ? depts.map((d) => d.name).join(', ') || 'the department' : 'the whole college',
    semesterNumber,
    notices: notices.length,
    revenue: methods.reduce((t, m) => t + m.total, 0),
    methods: methods.map((m) => ({ method: m._id, total: m.total, payments: m.n })),
    collected: s.collected,
    pending: s.pending,
    byType: s.byType.map((g) => ({ type: g.key, collected: g.collected, pending: g.pending, pendingStudents: g.pendingStudents })),
    byDepartment: s.byDepartment.map((g) => ({ department: deptName.get(g.key) || '-', collected: g.collected, pending: g.pending, pendingStudents: g.pendingStudents })),
    bySemester: s.bySemester.map((g) => {
      const [d, sem] = g.key.split('|');
      return { department: deptName.get(d) || '-', semester: semName.get(sem) || '-', collected: g.collected, pending: g.pending, pendingStudents: g.pendingStudents };
    }),
  };
};

// Students, teachers, courses and results of the chosen departments (null = every department), optionally one semester number.
// withLists adds the names (at most 100 students per department).
export const loadDepartmentReport = async ({ deptIds = null, semesterNumber = null, withLists = false } = {}) => {
  const dept = deptIds ? { department: { $in: deptIds.map(oid) } } : {};
  const depts = await Department.find(deptIds ? { _id: { $in: deptIds } } : { status: 'active' }).populate('hod', 'name').select('name code hod').lean();
  const semesters = await Semester.find(dept).select('name number department').lean();
  const semName = new Map(semesters.map((x) => [String(x._id), x]));
  const semIds = semesterNumber ? semesters.filter((x) => x.number === semesterNumber).map((x) => x._id) : null;

  const [stuAgg, teachers, courseAgg, resultAgg] = await Promise.all([
    StudentProfile.aggregate([{ $match: { ...dept, ...(semIds ? { semester: { $in: semIds } } : {}) } }, { $group: { _id: { d: '$department', s: '$semester', st: '$status' }, n: { $sum: 1 } } }]),
    User.find({
      role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true,
      ...(deptIds ? { $or: [{ department: { $in: deptIds } }, { extraDepartments: { $in: deptIds } }] } : {}),
    }).select('name department extraDepartments qualification').lean(),
    Course.aggregate([
      { $match: { status: COURSE_STATUS.ACTIVE, ...dept, ...(semIds ? { semester: { $in: semIds } } : {}) } },
      { $group: { _id: '$department', courses: { $sum: 1 }, withTeacher: { $sum: { $cond: [{ $ifNull: ['$teacher', false] }, 1, 0] } } } },
    ]),
    Result.aggregate([
      { $match: { status: RESULT_STATUS.PUBLISHED } },
      { $lookup: { from: StudentProfile.collection.name, localField: 'student', foreignField: 'user', as: 'p' } },
      { $unwind: '$p' },
      ...(deptIds ? [{ $match: { 'p.department': { $in: deptIds.map(oid) } } }] : []),
      { $group: { _id: '$p.department', results: { $sum: 1 }, avg: { $avg: '$percentage' },
        passed: { $sum: { $cond: [{ $regexMatch: { input: { $toString: '$outcome' }, regex: '^pass', options: 'i' } }, 1, 0] } } } },
    ]),
  ]);

  const out = [];
  for (const d of depts) {
    const id = String(d._id);
    const rows = stuAgg.filter((r) => String(r._id.d) === id);
    const bySem = new Map();
    for (const r of rows) {
      const k = String(r._id.s || 'none');
      const o = bySem.get(k) || { active: 0, other: 0 };
      if (r._id.st === STUDENT_STATUS.ACTIVE) o.active += r.n; else o.other += r.n;
      bySem.set(k, o);
    }
    const mine = teachers.filter((t) => String(t.department) === id || (t.extraDepartments || []).some((x) => String(x) === id));
    const c = courseAgg.find((x) => String(x._id) === id);
    const r = resultAgg.find((x) => String(x._id) === id);
    const card = {
      name: d.name, code: d.code, hod: d.hod?.name || 'not assigned',
      students: { active: rows.filter((x) => x._id.st === STUDENT_STATUS.ACTIVE).reduce((t, x) => t + x.n, 0), other: rows.filter((x) => x._id.st !== STUDENT_STATUS.ACTIVE).reduce((t, x) => t + x.n, 0) },
      semesterWise: [...bySem].map(([k, v]) => ({ semester: k === 'none' ? 'not placed' : semName.get(k)?.name || '-', number: semName.get(k)?.number ?? 99, ...v })).sort((a, b) => a.number - b.number),
      teachers: mine.length,
      courses: { total: c?.courses || 0, withTeacher: c?.withTeacher || 0 },
      performance: r ? { results: r.results, averagePercentage: Math.round(r.avg * 10) / 10, passRate: Math.round((r.passed / r.results) * 100) } : null,
    };
    if (withLists && depts.length === 1) {
      const list = await StudentProfile.find({ department: d._id, ...(semIds ? { semester: { $in: semIds } } : {}) })
        .populate('user', 'name').populate('semester', 'name').sort({ rollNumber: 1 }).limit(101).lean();
      card.studentList = list.slice(0, 100).map((p) => ({ name: p.user?.name, roll: p.rollNumber, semester: p.semester?.name || 'not placed', section: p.section, status: p.status }));
      card.studentListTruncated = list.length > 100;
      card.teacherList = mine.map((t) => ({ name: t.name, qualification: t.qualification || '' }));
    }
    out.push(card);
  }
  return out;
};

// ---------- presentation ----------
const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

// The facts as plain text for the AI model (it must not add anything that is not here).
export const recordsText = (d) => {
  const out = [`Searched for: ${[...d.parsed.codes, ...d.parsed.emails, ...d.parsed.names].join(', ') || 'nothing specific'}`];
  if (d.outsideScope) out.push(`${d.outsideScope} matching student(s) belong to another department and cannot be shown to this user.`);
  if (d.notFound.length) out.push(`No record was found for: ${d.notFound.join(', ')}`);
  for (const s of d.students) {
    out.push([
      `STUDENT ${s.name} | roll ${s.roll} | ${s.department} | ${s.semester} | section ${s.section} | ${s.status} | ${s.email} | ${s.phone || 'no phone'} | guardian: ${s.guardian || 'none'}`,
      s.courses ? `Courses: ${s.courses.map((c) => `${c.code} ${c.title} (teacher ${c.teacher})`).join('; ') || 'none'}` : '',
      s.attendance ? `Attendance (required ${s.attendanceRequired ?? 'n/a'}%): average ${s.attendanceAverage ?? 'n/a'}%; ${s.attendance.map((a) => `${a.code} ${a.percent ?? 'n/a'}% (P${a.present}/A${a.absent}/L${a.leave})`).join('; ')}` : '',
      s.fees ? `Fees outstanding: ${s.fees.outstanding.map((f) => `${f.title} ${f.amount} due ${f.due}`).join('; ') || 'none'}. Paid: ${s.fees.payments.map((p) => `${money(p.amount, p.currency)} ${p.method} receipt ${p.receipt} on ${p.date}`).join('; ') || 'none'}` : '',
      s.promotion ? `Promotion fees (${s.promotion.semester}): ${s.promotion.fees.map((f) => `${f.title} ${f.amount} due ${f.due} ${f.paid ? 'PAID' : 'NOT PAID'}`).join('; ') || 'no promotion fee notice for this semester'}` : '',
      s.exams ? `Results: ${s.exams.results.map((r) => `${r.exam} sem ${r.semester}: ${r.percentage}% ${r.grade} ${r.outcome}`).join('; ') || 'none published'}. Exam admission: ${s.exams.admissions.map((a) => `${a.exam} ${a.status}${a.reason ? ` (${a.reason})` : ''}`).join('; ') || 'none'}` : '',
    ].filter(Boolean).join('\n'));
  }
  for (const t of d.teachers) out.push(`TEACHER ${t.name} | ${t.role} | ${t.department} | ${t.qualification || 'no qualification'} | ${t.email} | ${t.phone || 'no phone'} | ${t.creditHours} credit hours, ${t.weeklyClasses} weekly classes | ${t.courses.join('; ') || 'no subjects'}`);
  for (const c of d.courses) out.push(`COURSE ${c.code} ${c.title} | ${c.department} | ${c.semester} sec ${c.section} | ${c.creditHours} credit hours | teacher ${c.teacher} | ${c.students} students | contents: ${c.contents || 'none'}`);
  if (d.refused?.length) out.push(`ACCESS: the user asked about ${d.refused.join(', ')}. That is outside their access (an HOD sees only their own department). Tell them so plainly and show nothing about it.`);
  if (d.finance) {
    const f = d.finance;
    out.push([
      `FEES for ${f.scope}${f.semesterNumber ? `, semester ${f.semesterNumber}` : ''} (${f.currency}): collected for fee notices ${f.collected}; pending (unpaid students x base fee) ${f.pending}; total verified revenue ${f.revenue} (${f.methods.map((m) => `${m.method} ${m.total}`).join(', ') || 'none'}); ${f.notices} fee notices.`,
      `By type: ${f.byType.map((t) => `${t.type} collected ${t.collected}, pending ${t.pending} (${t.pendingStudents} students)`).join('; ') || 'none'}`,
      `By department: ${f.byDepartment.map((t) => `${t.department} collected ${t.collected}, pending ${t.pending}`).join('; ') || 'none'}`,
      `By semester: ${f.bySemester.map((t) => `${t.department} ${t.semester} collected ${t.collected}, pending ${t.pending}`).join('; ') || 'none'}`,
    ].join('\n'));
  }
  for (const x of d.departments || []) {
    out.push([
      `DEPARTMENT ${x.name} (${x.code}) | HOD ${x.hod} | students: ${x.students.active} active, ${x.students.other} other | teachers ${x.teachers} | courses ${x.courses.total} (${x.courses.withTeacher} with a teacher) | results: ${x.performance ? `${x.performance.results} published, average ${x.performance.averagePercentage}%, pass rate ${x.performance.passRate}%` : 'none published'}`,
      `Semester-wise students: ${x.semesterWise.map((s) => `${s.semester} ${s.active} active${s.other ? `, ${s.other} other` : ''}`).join('; ') || 'none'}`,
      x.studentList ? `Students${x.studentListTruncated ? ' (first 100)' : ''}: ${x.studentList.map((s) => `${s.name} ${s.roll} ${s.semester}`).join('; ')}` : '',
      x.teacherList ? `Teachers: ${x.teacherList.map((t) => t.name).join('; ')}` : '',
    ].filter(Boolean).join('\n'));
  }
  return out.join('\n\n').slice(0, 14000);
};

// Without an AI key the same data is shown directly.
export const recordsFallback = (d) => {
  const out = [];
  if (d.outsideScope) out.push(`_${d.outsideScope} matching student(s) belong to another department and are not shown._`, '');
  for (const s of d.students) {
    out.push(`### ${s.name} · ${s.roll}`, `${s.department} · ${s.semester} · section ${s.section} · ${s.status}`, `- Email: ${s.email} · Phone: ${s.phone || '-'} · Guardian: ${s.guardian || '-'}`);
    if (s.courses) out.push('', '**Courses**', table(['Code', 'Subject', 'Teacher', 'Credit hrs'], s.courses.map((c) => [c.code, c.title, c.teacher, c.creditHours])));
    if (s.attendance) {
      out.push('', `**Attendance** (average ${s.attendanceAverage ?? 'n/a'}%${s.attendanceRequired ? `, required ${s.attendanceRequired}%` : ''})`,
        table(['Subject', 'Present', 'Absent', 'Leave', '%'], s.attendance.map((a) => [`${a.code} ${a.title}`, a.present, a.absent, a.leave, a.percent === null ? 'not marked' : `${a.percent}%`])));
    }
    if (s.fees) {
      out.push('', '**Fees**', s.fees.outstanding.length ? table(['Outstanding fee', 'Amount', 'Due'], s.fees.outstanding.map((f) => [f.title, f.amount, f.due])) : '- No outstanding fee.',
        s.fees.payments.length ? table(['Paid', 'Method', 'Receipt', 'Date'], s.fees.payments.map((p) => [money(p.amount, p.currency), p.method, p.receipt, p.date])) : '- No payment recorded yet.');
    }
    if (s.promotion) {
      out.push('', `**Promotion fees** (${s.promotion.semester})`, s.promotion.fees.length
        ? table(['Fee', 'Amount', 'Due', 'Status'], s.promotion.fees.map((f) => [f.title, f.amount, f.due, f.paid ? 'Paid' : 'Not paid']))
        : '- No promotion fee notice for this semester.');
    }
    if (s.exams) {
      out.push('', '**Examinations**', s.exams.results.length ? table(['Exam', 'Semester', 'Marks', '%', 'Grade', 'Outcome'], s.exams.results.map((r) => [r.exam, r.semester, r.total, r.percentage, r.grade, r.outcome])) : '- No published result.',
        s.exams.admissions.length ? table(['Exam', 'Admission', 'Reason'], s.exams.admissions.map((a) => [a.exam, a.status, a.reason])) : '- No admission request.');
    }
    out.push('');
  }
  for (const t of d.teachers) {
    out.push(`### ${t.name} · ${t.role}`, `${t.department} · ${t.qualification || 'qualification not set'}`, `- Email: ${t.email} · Phone: ${t.phone || '-'}`, `- Teaching: ${t.creditHours} credit hours, ${t.weeklyClasses} weekly classes`, ...t.courses.map((c) => `  - ${c}`), '');
  }
  for (const c of d.courses) {
    out.push(`### ${c.code} · ${c.title}`, `${c.department} · ${c.semester} · section ${c.section} · ${c.creditHours} credit hours`, `- Teacher: ${c.teacher} · Students: ${c.students}`, c.contents ? `- Contents: ${c.contents}` : '', '');
  }
  if (d.refused?.length) out.push(`**Not allowed:** ${d.refused.join(', ')} is outside your access. You can only see your own department.`, '');
  if (d.finance) {
    const f = d.finance;
    out.push(`### Fees: ${f.scope}${f.semesterNumber ? `, semester ${f.semesterNumber}` : ''}`,
      table(['Collected (fee notices)', 'Pending (unpaid x base fee)', 'Total verified revenue'], [[money(f.collected, f.currency), money(f.pending, f.currency), money(f.revenue, f.currency)]]));
    if (f.methods.length) out.push('', table(['Payment method', 'Payments', 'Amount'], f.methods.map((m) => [m.method, m.payments, money(m.total, f.currency)])));
    if (f.byType.length) out.push('', '**By fee type**', table(['Type', 'Collected', 'Pending', 'Students owing'], f.byType.map((t) => [t.type, money(t.collected, f.currency), money(t.pending, f.currency), t.pendingStudents])));
    if (f.byDepartment.length > 1) out.push('', '**By department**', table(['Department', 'Collected', 'Pending', 'Students owing'], f.byDepartment.map((t) => [t.department, money(t.collected, f.currency), money(t.pending, f.currency), t.pendingStudents])));
    if (f.bySemester.length) out.push('', '**By semester**', table(['Department', 'Semester', 'Collected', 'Pending', 'Students owing'], f.bySemester.map((t) => [t.department, t.semester, money(t.collected, f.currency), money(t.pending, f.currency), t.pendingStudents])));
    if (!f.notices) out.push('', '_No published fee notice was found for this selection._');
    out.push('');
  }
  for (const x of d.departments || []) {
    out.push(`### ${x.name} (${x.code})`, `HOD: ${x.hod}`,
      table(['Active students', 'Other students', 'Teachers', 'Courses', 'Courses with a teacher'], [[x.students.active, x.students.other, x.teachers, x.courses.total, x.courses.withTeacher]]));
    if (x.semesterWise.length) out.push('', '**Students by semester**', table(['Semester', 'Active', 'Other'], x.semesterWise.map((s) => [s.semester, s.active, s.other])));
    out.push(x.performance ? `\n**Results:** ${x.performance.results} published · average ${x.performance.averagePercentage}% · pass rate ${x.performance.passRate}%` : '\n**Results:** none published yet');
    if (x.studentList) out.push('', `**Students${x.studentListTruncated ? ' (first 100)' : ''}**`, table(['Name', 'Roll no', 'Semester', 'Section', 'Status'], x.studentList.map((s) => [s.name, s.roll, s.semester, s.section, s.status])));
    if (x.teacherList) out.push('', '**Teachers**', table(['Name', 'Qualification'], x.teacherList.map((t) => [t.name, t.qualification])));
    out.push('');
  }
  if (!out.length || (!d.students.length && !d.teachers.length && !d.courses.length && !d.finance && !d.departments && !d.refused?.length)) {
    out.push(d.notFound.length ? `No record found for **${d.notFound.join(', ')}**. Check the roll number (for example CS-S1-03), or search by the student's name or email.` : 'Type a roll number, a name, an email or a course code. For example: **CS-S1-03**, **attendance of CS-S1-03**, **fees of CS-S1-03**.');
  }
  return out.filter((x) => x !== undefined).join('\n');
};
