import StudentProfile from '../models/StudentProfile.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import Semester from '../models/Semester.js';
import FeeNotice from '../models/FeeNotice.js';
import Payment from '../models/Payment.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { ROLES, FEE_NOTICE_STATUS, PAYMENT_STATUS, STUDENT_STATUS } from '../config/constants.js';

// ============================================================================================
// Promotion fee ledger: for every student of a department, was the promotion fee of EACH semester they went
// through paid? It answers "who is studying in the 7th semester without ever paying a promotion fee?".
//
// Cell states, per student and semester number (1 .. the student's current semester):
//   paid        every promotion notice of that semester is paid
//   unpaid      a promotion notice exists for that semester but the student has not paid it
//   no_notice   an earlier semester that never had a promotion fee notice, so nothing was paid (counts as owing)
//   no_record   the system has no enrolment of this student in that semester (for example admitted into a later semester)
//   current     the student's current semester; its promotion fee is not overdue yet
// ============================================================================================
export const promotionLedger = asyncHandler(async (req, res) => {
  const isHod = req.user.role === ROLES.HOD;
  const deptId = isHod ? req.user.department : req.query.department;
  if (!deptId) throw ApiError.badRequest('Choose a department');

  const profiles = await StudentProfile.find({ department: deptId, status: STUDENT_STATUS.ACTIVE, semester: { $ne: null } })
    .populate('semester', 'number name academicYear')
    .lean();
  const wantNumber = req.query.semesterNumber;
  const students = profiles.filter((p) => p.semester && (!wantNumber || p.semester.number === wantNumber));
  const userIds = students.map((p) => p.user);

  const [users, pairs] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('name').lean(),
    CourseEnrollment.aggregate([{ $match: { student: { $in: userIds } } }, { $group: { _id: { student: '$student', semester: '$semester' } } }]),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));

  // Which semester documents did each student pass through?
  const semIds = new Set(students.map((p) => String(p.semester._id)));
  pairs.forEach((x) => semIds.add(String(x._id.semester)));
  const semesters = await Semester.find({ _id: { $in: [...semIds] } }).select('number name academicYear').lean();
  const semById = new Map(semesters.map((s) => [String(s._id), s]));

  const historyOf = new Map(); // student id -> Map(semester number -> semester doc)
  const remember = (studentId, sem) => {
    if (!sem) return;
    const m = historyOf.get(studentId) || new Map();
    const have = m.get(sem.number);
    if (!have || String(sem.academicYear) > String(have.academicYear)) m.set(sem.number, sem); // a repeated semester: keep the latest
    historyOf.set(studentId, m);
  };
  pairs.forEach((x) => remember(String(x._id.student), semById.get(String(x._id.semester))));
  students.forEach((p) => remember(String(p.user), semById.get(String(p.semester._id))));

  // Promotion notices and who paid them
  const notices = await FeeNotice.find({ feeType: 'promotion', semester: { $in: [...semIds] }, status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] } }).lean();
  const noticesBySem = new Map();
  notices.forEach((n) => noticesBySem.set(String(n.semester), [...(noticesBySem.get(String(n.semester)) || []), n]));
  const payments = notices.length
    ? await Payment.find({ student: { $in: userIds }, status: PAYMENT_STATUS.PAID, 'items.notice': { $in: notices.map((n) => n._id) } }).select('student paidAt receiptNumber items').lean()
    : [];
  const paid = new Map(); // "student:notice" -> payment
  payments.forEach((p) => p.items.forEach((i) => paid.set(`${p.student}:${i.notice}`, { paidAt: p.paidAt, receiptNumber: p.receiptNumber, total: i.total })));

  const columns = Math.min(Math.max(...students.map((p) => p.semester.number), 0), 12);
  const missing = new Map(); // semester id -> { semester, students } for earlier semesters without any promotion notice
  const bySemester = Array.from({ length: columns }, (_, i) => ({ number: i + 1, paid: 0, unpaid: 0, noNotice: 0, noRecord: 0 }));

  let rows = students.map((p) => {
    const sid = String(p.user);
    const current = p.semester.number;
    const hist = historyOf.get(sid) || new Map();
    const cells = {};
    let overdue = 0;
    let overdueAmount = 0;

    for (let n = 1; n <= current; n += 1) {
      const sem = hist.get(n);
      let cell;
      if (!sem) {
        cell = { state: 'no_record' };
      } else {
        const list = noticesBySem.get(String(sem._id)) || [];
        if (!list.length) {
          cell = { state: 'no_notice', semesterId: sem._id, semesterName: sem.name, lines: [] };
        } else {
          const lines = list.map((nt) => {
            const pay = paid.get(`${sid}:${nt._id}`);
            return { notice: nt._id, title: nt.title, amount: nt.amount, dueDate: nt.dueDate, paid: !!pay, paidAt: pay?.paidAt || null, receiptNumber: pay?.receiptNumber || null, paidTotal: pay?.total ?? null };
          });
          const due = lines.filter((l) => !l.paid).reduce((s, l) => s + l.amount, 0);
          cell = { state: lines.every((l) => l.paid) ? 'paid' : 'unpaid', semesterId: sem._id, semesterName: sem.name, lines, due };
        }
      }
      if (n === current && cell.state !== 'paid') cell.state = 'current'; // the current semester's fee is not overdue yet
      if (n < current) {
        const b = bySemester[n - 1];
        if (cell.state === 'paid') b.paid += 1;
        else if (cell.state === 'unpaid') b.unpaid += 1;
        else if (cell.state === 'no_notice') b.noNotice += 1;
        else b.noRecord += 1;
        if (cell.state === 'unpaid' || cell.state === 'no_notice') overdue += 1;
        if (cell.state === 'unpaid') overdueAmount += cell.due;
        if (cell.state === 'no_notice') {
          const m = missing.get(String(cell.semesterId)) || { semesterId: cell.semesterId, semesterName: cell.semesterName, number: n, students: 0 };
          m.students += 1;
          missing.set(String(cell.semesterId), m);
        }
      }
      cells[n] = cell;
    }
    return {
      student: p.user, name: name.get(sid), rollNumber: p.rollNumber, section: p.section,
      currentNumber: current, currentSemester: p.semester.name, cells, overdue, overdueAmount,
    };
  });

  const summary = {
    students: rows.length,
    clear: rows.filter((r) => r.overdue === 0).length,
    withDues: rows.filter((r) => r.overdue > 0).length,
    outstandingAmount: rows.reduce((s, r) => s + r.overdueAmount, 0),
  };

  if (req.query.unpaidOnly === 'true') rows = rows.filter((r) => r.overdue > 0);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    rows = rows.filter((r) => (r.name || '').toLowerCase().includes(q) || r.rollNumber.toLowerCase().includes(q));
  }
  rows.sort((a, b) => b.overdue - a.overdue || a.rollNumber.localeCompare(b.rollNumber));

  sendSuccess(res, {
    columns,
    summary,
    bySemester: bySemester.filter((b) => b.number < columns || b.paid + b.unpaid + b.noNotice + b.noRecord > 0),
    missingNotices: [...missing.values()].sort((a, b) => a.number - b.number),
    rows,
  });
});
