import Examination from '../models/Examination.js';
import FeeNotice from '../models/FeeNotice.js';
import StudentDocument from '../models/StudentDocument.js';
import Assignment from '../models/Assignment.js';
import Submission from '../models/Submission.js';
import Result from '../models/Result.js';
import Payment from '../models/Payment.js';
import Semester from '../models/Semester.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { attendanceCounts, emptyCounts, attendancePercent } from './attendanceService.js';
import { paidNoticeIds } from './feeService.js';
import { studentCourseIds } from './accessService.js';
import { FEE_NOTICE_STATUS, REVIEW_STATUS, RESULT_STATUS, PAYMENT_STATUS } from '../config/constants.js';

// ===== Admission eligibility. Pure rules -> check lines (unit tested through summarizeChecks) =====
export const summarizeChecks = (checks) => {
  const failing = checks.filter((c) => !c.passed);
  return {
    allPassed: failing.length === 0,
    reason: failing.length ? `Waiting for: ${failing.map((c) => `${c.label} (${c.detail})`).join('; ')}` : 'All requirements are met',
  };
};

// Evaluates every configured rule for one student and one examination.
export const evaluateAdmission = async ({ studentId, profile, exam }) => {
  const settings = await UniversitySettings.getSettings();
  const rules = settings.admissionRules;
  const checks = [];

  const examCourseIds = exam.papers.map((p) => String(p.course?._id || p.course));
  const myCourseIds = (await studentCourseIds(studentId, exam.semester?._id || exam.semester)).map(String).filter((id) => examCourseIds.includes(id));

  // 1) Attendance in every examined course
  const counts = await attendanceCounts({ courseIds: myCourseIds, studentIds: [studentId] });
  const low = [];
  for (const cid of myCourseIds) {
    const pct = attendancePercent(counts.get(`${cid}:${studentId}`) || emptyCounts(), settings.attendanceRules.allowApprovedLeaveAsPresent);
    if (pct !== null && pct < rules.minAttendancePercentage) low.push(`${pct}%`);
  }
  checks.push({
    key: 'attendance',
    label: `Attendance at least ${rules.minAttendancePercentage}% in every course`,
    passed: low.length === 0,
    detail: low.length ? `${low.length} course(s) below the limit` : 'OK',
  });

  // 2) Fees linked to this examination
  const notices = await FeeNotice.find({ examination: exam._id, status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] } });
  if (rules.requireFeePayment) {
    const paid = await paidNoticeIds(studentId);
    const unpaid = notices.filter((n) => !paid.has(String(n._id)));
    checks.push({
      key: 'fees',
      label: 'Examination fee paid',
      passed: unpaid.length === 0,
      detail: unpaid.length ? `unpaid: ${unpaid.map((n) => n.title).join(', ')}` : notices.length ? 'Paid' : 'No fee notice for this examination',
    });
  }

  // 3) Required documents (approved by staff)
  if (rules.requireDocuments) {
    const required = [...new Set(notices.flatMap((n) => n.requiredDocuments))];
    if (required.length) {
      const approved = await StudentDocument.find({ student: studentId, status: REVIEW_STATUS.APPROVED }).distinct('type');
      // A student who pays at the office hands the papers over in person. The finance officer ticks "received at the office" on that payment.
      const office = await Payment.find({ student: studentId, status: PAYMENT_STATUS.PAID, 'items.notice': { $in: notices.map((n) => n._id) } }).select('requirements.documents').lean();
      const handedIn = new Set(office.flatMap((p) => (p.requirements?.documents || []).filter((d) => d.status === 'received_at_office').map((d) => d.type)));
      const missing = required.filter((t) => !approved.includes(t) && !handedIn.has(t));
      checks.push({
        key: 'documents',
        label: 'Required documents approved',
        passed: missing.length === 0,
        detail: missing.length ? `not approved yet: ${missing.join(', ')}` : 'Approved',
      });
    }
  }

  // 4) Assignment completion (only when the university switched the rule on)
  if (rules.minAssignmentCompletionPercentage > 0) {
    const due = await Assignment.find({ course: { $in: myCourseIds }, deadline: { $lt: new Date() } }).select('_id').lean();
    const done = due.length ? await Submission.countDocuments({ student: studentId, assignment: { $in: due.map((a) => a._id) } }) : 0;
    const pct = due.length ? (done / due.length) * 100 : 100;
    checks.push({
      key: 'assignments',
      label: `At least ${rules.minAssignmentCompletionPercentage}% of assignments submitted`,
      passed: pct >= rules.minAssignmentCompletionPercentage,
      detail: `${done} of ${due.length} submitted`,
    });
  }

  // 5) No failed result in an earlier semester
  if (rules.requirePreviousSemesterPass) {
    const sem = await Semester.findById(exam.semester?._id || exam.semester).select('number');
    const failed = await Result.countDocuments({ student: studentId, status: RESULT_STATUS.PUBLISHED, outcome: 'fail', semesterNumber: { $lt: sem.number } });
    checks.push({ key: 'previous_result', label: 'Previous semester results passed', passed: failed === 0, detail: failed ? `${failed} failed result(s)` : 'OK' });
  }

  return { checks, ...summarizeChecks(checks) };
};

export const loadExamWithPapers = (id) => Examination.findById(id).populate('papers.course', 'code title');
