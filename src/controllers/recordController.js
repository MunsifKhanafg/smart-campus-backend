import StudentProfile from '../models/StudentProfile.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import Submission from '../models/Submission.js';
import QuizAttempt from '../models/QuizAttempt.js';
import Result from '../models/Result.js';
import DMC from '../models/DMC.js';
import ExaminationAdmission from '../models/ExaminationAdmission.js';
import Payment from '../models/Payment.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { attendanceCounts, attendancePercent, emptyCounts } from '../services/attendanceService.js';
import { ATTEMPT_STATUS, RESULT_STATUS, PAYMENT_STATUS } from '../config/constants.js';

// The complete academic history of one student, grouped by semester (requirement 16).
export const buildRecord = async (userId) => {
  const profile = await StudentProfile.findOne({ user: userId })
    .populate('user', 'name email phone')
    .populate('department', 'name code')
    .populate('semester', 'name number academicYear status');
  if (!profile) throw ApiError.notFound('Student not found');
  const settings = await UniversitySettings.getSettings();

  const enrollments = await CourseEnrollment.find({ student: userId })
    .populate({ path: 'course', select: 'code title section creditHours teacher', populate: { path: 'teacher', select: 'name' } })
    .populate('semester', 'name number academicYear')
    .lean();
  const courseIds = enrollments.map((e) => e.course?._id).filter(Boolean);

  const [counts, subs, attempts, results, admissions, payments] = await Promise.all([
    attendanceCounts({ courseIds, studentIds: [userId] }),
    Submission.find({ student: userId }).populate('assignment', 'title type maxMarks deadline').lean(),
    QuizAttempt.find({ student: userId, status: { $ne: ATTEMPT_STATUS.IN_PROGRESS } }).populate('quiz', 'title').lean(),
    Result.find({ student: userId, status: RESULT_STATUS.PUBLISHED }).populate('examination', 'name type').populate('semester', 'name number').sort({ publishedAt: 1 }).lean(),
    ExaminationAdmission.find({ student: userId }).populate('examination', 'name').sort({ requestedAt: -1 }).lean(),
    Payment.find({ student: userId, status: { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.REFUNDED] } }).sort({ paidAt: -1 }).lean(),
  ]);
  const dmcs = await DMC.find({ result: { $in: results.map((r) => r._id) } }).select('result dmcNumber').lean();
  const dmcBy = new Map(dmcs.map((d) => [String(d.result), d.dmcNumber]));

  // semester -> courses
  const semesters = new Map();
  for (const e of enrollments) {
    if (!e.course || !e.semester) continue;
    const key = String(e.semester._id);
    if (!semesters.has(key)) semesters.set(key, { semester: e.semester, courses: [] });
    const c = e.course;
    const cnt = counts.get(`${c._id}:${userId}`) || emptyCounts();
    semesters.get(key).courses.push({
      _id: c._id,
      code: c.code,
      title: c.title,
      section: c.section,
      creditHours: c.creditHours,
      teacher: c.teacher?.name || null,
      enrollmentStatus: e.status,
      attendance: { ...cnt, percent: attendancePercent(cnt, settings.attendanceRules.allowApprovedLeaveAsPresent) },
      assignments: subs
        .filter((s) => String(s.course) === String(c._id))
        .map((s) => ({ title: s.assignment?.title, type: s.assignment?.type, marks: s.marks, maxMarks: s.assignment?.maxMarks, late: s.isLate, feedback: s.feedback })),
      quizzes: attempts
        .filter((a) => String(a.course) === String(c._id))
        .map((a) => ({ title: a.quiz?.title, score: a.score, maxScore: a.maxScore, attempt: a.attemptNumber })),
    });
  }

  // Promotion is only SHOWN here (derived from published results). The decision itself stays with the university.
  const bySemester = new Map();
  for (const r of results) {
    const key = r.semester?.name || `Semester ${r.semesterNumber}`;
    const row = bySemester.get(key) || { semester: key, number: r.semesterNumber, outcomes: [] };
    row.outcomes.push(r.outcome);
    bySemester.set(key, row);
  }

  return {
    profile,
    semesters: [...semesters.values()].sort((a, b) => a.semester.number - b.semester.number),
    results: results.map((r) => ({ ...r, dmcNumber: dmcBy.get(String(r._id)) || null })),
    admissions: admissions.map((a) => ({ examination: a.examination?.name, status: a.status, reason: a.reason, requestedAt: a.requestedAt })),
    payments: payments.map((p) => ({ _id: p._id, total: p.totalAmount, currency: p.currency, status: p.status, paidAt: p.paidAt, receiptNumber: p.receiptNumber, items: p.items.map((i) => i.title) })),
    promotion: {
      currentSemester: profile.semester?.name || null,
      history: [...bySemester.values()]
        .sort((a, b) => a.number - b.number)
        .map((r) => ({ semester: r.semester, outcome: r.outcomes.every((o) => o === 'pass') ? 'pass' : 'fail' })),
      note: 'Promotion to the next semester is decided by the department according to university rules.',
    },
  };
};

export const myRecord = asyncHandler(async (req, res) => {
  sendSuccess(res, await buildRecord(req.user._id));
});

// HOD of the student's department, or the University Head.
export const studentRecord = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.params.id }).select('department');
  if (!profile) throw ApiError.notFound('Student not found');
  assertDepartmentAccess(req.user, profile.department);
  sendSuccess(res, await buildRecord(req.params.id));
});
