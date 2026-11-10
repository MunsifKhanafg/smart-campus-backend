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
import { ROLES, ENROLLMENT_STATUS, COURSE_STATUS, PAYMENT_STATUS, FEE_NOTICE_STATUS, RESULT_STATUS } from '../config/constants.js';

// ==========================================================================================================
// "Search records": the principal, the HODs and the finance office type a roll number (or a name, an email, a course code)
// and get the student, teacher or course with attendance, fees and examinations. The data is read from the database by this
// file, so nothing is guessed. An HOD only reaches their own department; the principal and the finance office reach all.
// To limit what a role may see, change FACETS_BY_ROLE (one line per role).
// ==========================================================================================================

const ALL_FACETS = ['attendance', 'fees', 'exam', 'courses'];
export const FACETS_BY_ROLE = {
  [ROLES.UNIVERSITY_HEAD]: ALL_FACETS,
  [ROLES.HOD]: ALL_FACETS,
  [ROLES.FINANCE_OFFICER]: ALL_FACETS,
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STOP = new Set(
  `a an and are all about as at be by can do does for from get give has have how i in info information is it me my of on or please show tell that the their them there this to us what when where which who with you your
  find search look details detail record records student students teacher teachers faculty course courses subject subjects roll number no num attendance attend present absent leave fee fees paid payment payments due dues
  exam exams result results marks grade gpa dmc midterm final admission class timetable enrolled status full complete everything`.split(/\s+/)
);

// A roll number or course code has letters AND digits ("CS-S1-03", "21CS045", "CS-4301").
const looksLikeCode = (t) => t.length >= 4 && /\d/.test(t) && /[a-z]/i.test(t);

// Understands the question (pure, unit tested): which codes, emails and names, and which kind of information is wanted.
// When no kind is named ("CS-S1-03"), everything is shown.
export const parseRecordsQuery = (question) => {
  const text = String(question || '');
  const lower = text.toLowerCase();
  const emails = [...new Set((text.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g) || []).map((e) => e.toLowerCase()))];
  const plain = text.replace(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g, ' ');
  const tokens = plain.match(/[A-Za-z0-9](?:[A-Za-z0-9_./-]*[A-Za-z0-9])?/g) || [];
  const codes = [...new Set(tokens.filter(looksLikeCode).map((t) => t.toUpperCase()))];
  const names = [...new Set(tokens.filter((t) => /^[a-z]{3,}$/i.test(t) && !STOP.has(t.toLowerCase())))];
  const facets = {
    attendance: /attend|present|absent|bunk|leaves?\b/.test(lower),
    fees: /\bfees?\b|paid|payment|dues?\b|challan|receipt|balance|outstanding|unpaid/.test(lower),
    exam: /exam|result|marks|grade|gpa|dmc|midterm|final|admit|admission/.test(lower),
    courses: /course|subject|class|timetable|enrol/.test(lower),
  };
  const any = Object.values(facets).some(Boolean);
  return { codes, emails, names, facets, all: !any, wantsTeacher: /\b(teachers?|faculty|sir|madam|lecturers?|professors?)\b/.test(lower) };
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
  return new Set(wanted.filter((f) => allowed.includes(f)));
};

const money = (n, c = 'PKR') => `${c} ${Number(n || 0).toLocaleString('en-US')}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');

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
export const searchRecords = async (user, question) => {
  const parsed = parseRecordsQuery(question);
  const facets = asFacets(user.role, parsed);
  const hodOnly = user.role === ROLES.HOD ? { department: user.department } : {};
  const settings = await UniversitySettings.getSettings();
  const data = { students: [], teachers: [], courses: [], notFound: [], outsideScope: 0, parsed, facets: [...facets] };

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
  if ((parsed.wantsTeacher || (!or.length && nameRx)) && (nameRx || parsed.emails.length)) {
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

  // courses: by code
  if (rollRx.length) {
    const found = await Course.find({ code: { $in: rollRx }, ...hodOnly }).limit(6).populate('teacher', 'name').populate('semester', 'name').populate('department', 'name').lean();
    for (const c of found) {
      data.courses.push({
        code: c.code, title: c.title, department: c.department?.name || '', semester: c.semester?.name || '', section: c.section, creditHours: c.creditHours, status: c.status,
        teacher: c.teacher?.name || 'not assigned', students: await CourseEnrollment.countDocuments({ course: c._id, status: ENROLLMENT_STATUS.ENROLLED }),
        contents: (c.outline || '').slice(0, 600),
      });
    }
  }

  if (!data.students.length && !data.teachers.length && !data.courses.length) data.notFound = [...parsed.codes, ...parsed.emails, ...parsed.names].slice(0, 6);
  return data;
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
      s.exams ? `Results: ${s.exams.results.map((r) => `${r.exam} sem ${r.semester}: ${r.percentage}% ${r.grade} ${r.outcome}`).join('; ') || 'none published'}. Exam admission: ${s.exams.admissions.map((a) => `${a.exam} ${a.status}${a.reason ? ` (${a.reason})` : ''}`).join('; ') || 'none'}` : '',
    ].filter(Boolean).join('\n'));
  }
  for (const t of d.teachers) out.push(`TEACHER ${t.name} | ${t.role} | ${t.department} | ${t.qualification || 'no qualification'} | ${t.email} | ${t.phone || 'no phone'} | ${t.creditHours} credit hours, ${t.weeklyClasses} weekly classes | ${t.courses.join('; ') || 'no subjects'}`);
  for (const c of d.courses) out.push(`COURSE ${c.code} ${c.title} | ${c.department} | ${c.semester} sec ${c.section} | ${c.creditHours} credit hours | teacher ${c.teacher} | ${c.students} students | contents: ${c.contents || 'none'}`);
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
  if (!out.length || (!d.students.length && !d.teachers.length && !d.courses.length)) {
    out.push(d.notFound.length ? `No record found for **${d.notFound.join(', ')}**. Check the roll number (for example CS-S1-03), or search by the student's name or email.` : 'Type a roll number, a name, an email or a course code. For example: **CS-S1-03**, **attendance of CS-S1-03**, **fees of CS-S1-03**.');
  }
  return out.filter((x) => x !== undefined).join('\n');
};
