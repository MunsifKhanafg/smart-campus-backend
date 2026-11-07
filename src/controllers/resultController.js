import crypto from 'crypto';
import Examination from '../models/Examination.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import Result from '../models/Result.js';
import DMC from '../models/DMC.js';
import Counter from '../models/Counter.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import StudentProfile from '../models/StudentProfile.js';
import Semester from '../models/Semester.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { dayStart } from '../utils/oid.js';
import { createAttemptGuard } from '../utils/attemptGuard.js';
import { computeResult } from '../services/gradingService.js';
import { renderDmc } from '../services/pdfService.js';
import { ROLES, EXAM_STATUS, RESULT_STATUS, MARKS_STATUS, ENROLLMENT_STATUS } from '../config/constants.js';

const loadExam = async (id) => {
  const exam = await Examination.findById(id).populate('papers.course', 'code title');
  if (!exam) throw ApiError.notFound('Examination not found');
  return exam;
};

// ---------- HOD: calculate results from the submitted marks ----------
export const compileResults = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department);
  if (exam.status !== EXAM_STATUS.PUBLISHED) throw ApiError.badRequest('Publish the date sheet first');

  const courseIds = exam.papers.map((p) => p.course._id);
  const [enrollments, marks, existing, semester, settings] = await Promise.all([
    CourseEnrollment.find({ course: { $in: courseIds }, status: ENROLLMENT_STATUS.ENROLLED }).select('student course').lean(),
    ExaminationMarks.find({ examination: exam._id }).lean(),
    Result.find({ examination: exam._id }).select('student status').lean(),
    Semester.findById(exam.semester).select('number'),
    UniversitySettings.getSettings(),
  ]);

  // Every paper must have complete, submitted marks before any result is calculated.
  const incomplete = [];
  for (const paper of exam.papers) {
    const enrolled = enrollments.filter((e) => String(e.course) === String(paper.course._id)).length;
    const done = marks.filter(
      (m) => String(m.course) === String(paper.course._id) && m.status === MARKS_STATUS.SUBMITTED && (m.absent || m.marks !== null)
    ).length;
    if (done < enrolled) incomplete.push({ course: paper.course.code, enrolled, submitted: done });
  }
  if (incomplete.length) throw new ApiError(409, 'Some teachers have not submitted all marks yet', incomplete);

  const published = new Set(existing.filter((r) => r.status === RESULT_STATUS.PUBLISHED).map((r) => String(r.student)));
  const marksBy = new Map(marks.map((m) => [`${m.course}:${m.student}`, m]));
  const students = [...new Set(enrollments.map((e) => String(e.student)))];

  let created = 0;
  let skipped = 0;
  let pass = 0;
  let fail = 0;
  for (const studentId of students) {
    if (published.has(studentId)) { skipped += 1; continue; }
    const mine = new Set(enrollments.filter((e) => String(e.student) === studentId).map((e) => String(e.course)));
    const subjects = exam.papers
      .filter((p) => mine.has(String(p.course._id)))
      .map((p) => {
        const m = marksBy.get(`${p.course._id}:${studentId}`);
        return { course: p.course._id, code: p.course.code, title: p.course.title, maxMarks: p.maxMarks, passingMarks: p.passingMarks, obtained: m?.marks ?? 0, absent: !!m?.absent };
      });
    if (!subjects.length) continue;

    const calc = computeResult(subjects, settings);
    await Result.findOneAndUpdate(
      { examination: exam._id, student: studentId },
      { $set: { ...calc, department: exam.department, semester: exam.semester, semesterNumber: semester.number, status: RESULT_STATUS.DRAFT, compiledBy: req.user._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    created += 1;
    if (calc.outcome === 'pass') pass += 1; else fail += 1;
  }
  logAudit(req, 'result.compile', 'Examination', exam._id, { created, skipped, pass, fail });
  sendSuccess(res, { calculated: created, skippedAlreadyPublished: skipped, pass, fail }, 'Results calculated. Review them, then publish');
});

export const listExamResults = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department);
  const results = await Result.find({ examination: exam._id }).lean();
  const ids = results.map((r) => r.student);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name').lean(),
    StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean(),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  const rows = results
    .map((r) => ({ ...r, studentName: name.get(String(r.student)), rollNumber: roll.get(String(r.student)) || '' }))
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));
  sendSuccess(res, { examination: { _id: exam._id, name: exam.name, status: exam.status }, rows });
});

const issueDmc = async (result, issuedBy) => {
  const year = new Date().getFullYear();
  const seq = await Counter.next(`dmc-${year}`);
  return DMC.create({
    result: result._id,
    examination: result.examination,
    student: result.student,
    dmcNumber: `DMC-${year}-${String(seq).padStart(6, '0')}`,
    verificationCode: crypto.randomBytes(5).toString('hex').toUpperCase(),
    issuedBy,
  });
};

// ---------- HOD: publish (after reviewing the draft results) ----------
export const publishResults = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department);

  const drafts = await Result.find({ examination: exam._id, status: RESULT_STATUS.DRAFT });
  if (!drafts.length) throw ApiError.badRequest('There are no calculated results to publish. Calculate them first');

  // If a teacher changed marks after the results were calculated, they are stale.
  const lastMarks = await ExaminationMarks.findOne({ examination: exam._id }).sort({ updatedAt: -1 }).select('updatedAt');
  const oldest = Math.min(...drafts.map((r) => r.updatedAt.getTime()));
  if (lastMarks && lastMarks.updatedAt.getTime() > oldest) {
    throw ApiError.conflict('Marks changed after the results were calculated. Calculate the results again');
  }

  for (const r of drafts) {
    r.status = RESULT_STATUS.PUBLISHED;
    r.publishedAt = new Date();
    r.publishedBy = req.user._id;
    await r.save();
    if (!(await DMC.exists({ result: r._id }))) await issueDmc(r, req.user._id);
  }
  await notifyUsers(drafts.map((r) => r.student), {
    title: 'Result published',
    message: `${exam.name}: your result and DMC are available`,
    type: 'result',
    link: '/results',
  });
  logAudit(req, 'result.publish', 'Examination', exam._id, { count: drafts.length });
  sendSuccess(res, { published: drafts.length }, 'Results published and DMCs issued');
});

// ---------- Student ----------
export const myResults = asyncHandler(async (req, res) => {
  const results = await Result.find({ student: req.user._id, status: RESULT_STATUS.PUBLISHED })
    .populate('examination', 'name type')
    .populate('semester', 'name number academicYear')
    .sort({ publishedAt: -1 })
    .lean();
  const dmcs = await DMC.find({ result: { $in: results.map((r) => r._id) } }).select('result dmcNumber').lean();
  const dmcBy = new Map(dmcs.map((d) => [String(d.result), d.dmcNumber]));
  sendSuccess(res, results.map((r) => ({ ...r, dmcNumber: dmcBy.get(String(r._id)) || null })));
});

export const downloadDmc = asyncHandler(async (req, res) => {
  const result = await Result.findById(req.params.id);
  if (!result) throw ApiError.notFound('Result not found');
  if (req.user.role === ROLES.STUDENT) {
    if (String(result.student) !== String(req.user._id)) throw ApiError.forbidden();
  } else {
    assertDepartmentAccess(req.user, result.department);
  }
  if (result.status !== RESULT_STATUS.PUBLISHED) throw ApiError.badRequest('This result is not published yet');

  const [settings, student, profile, department, semester, exam, dmc] = await Promise.all([
    UniversitySettings.getSettings(),
    User.findById(result.student),
    StudentProfile.findOne({ user: result.student }),
    Department.findById(result.department),
    Semester.findById(result.semester),
    Examination.findById(result.examination),
    DMC.findOne({ result: result._id }),
  ]);
  if (!dmc) throw ApiError.notFound('DMC has not been issued for this result');
  renderDmc(res, { settings, student, profile, department, semester, exam, result, dmc });
});

// ---------- Public (no login) ----------
const NOT_FOUND = 'No published result was found for the details you entered';

// A roll number alone is never enough. The date of birth stored in the student's profile must match as well.
// After 5 wrong guesses for the same roll number the public page locks that roll number for 30 minutes,
// even if the guesses come from many different IP addresses. (Students can still use their login.)
const resultGuard = createAttemptGuard({ max: 5, windowMs: 30 * 60 * 1000 });

export const publicCheckResult = asyncHandler(async (req, res) => {
  const rollKey = req.body.rollNumber.toUpperCase();
  if (resultGuard.isBlocked(rollKey)) {
    throw new ApiError(429, 'Too many failed attempts for this roll number. Please try again in 30 minutes or sign in to your account');
  }
  const profile = await StudentProfile.findOne({ rollNumber: rollKey }).select('user dateOfBirth');
  const ok = profile?.dateOfBirth && dayStart(profile.dateOfBirth).getTime() === dayStart(req.body.dateOfBirth).getTime();
  if (!ok) {
    resultGuard.fail(rollKey);
    throw ApiError.notFound(NOT_FOUND);
  }
  resultGuard.reset(rollKey);

  const filter = { student: profile.user, status: RESULT_STATUS.PUBLISHED };
  if (req.body.examination) filter.examination = req.body.examination;
  const results = await Result.find(filter).populate('examination', 'name type').populate('semester', 'name').sort({ publishedAt: -1 }).lean();
  if (!results.length) throw ApiError.notFound(NOT_FOUND);

  const user = await User.findById(profile.user).select('name');
  sendSuccess(res, {
    studentName: user.name,
    rollNumber: req.body.rollNumber.toUpperCase(),
    results: results.map((r) => ({
      examination: r.examination?.name,
      type: r.examination?.type,
      semester: r.semester?.name,
      subjects: r.subjects.map((s) => ({ code: s.code, title: s.title, maxMarks: s.maxMarks, obtained: s.absent ? 'ABS' : s.obtained, passed: s.passed })),
      totalObtained: r.totalObtained,
      totalMax: r.totalMax,
      percentage: r.percentage,
      grade: r.grade,
      outcome: r.outcome,
    })),
  });
});

// Anyone holding a printed DMC can check that it is genuine.
export const publicVerifyDmc = asyncHandler(async (req, res) => {
  const dmc = await DMC.findOne({ dmcNumber: String(req.body.dmcNumber).toUpperCase().trim() });
  if (!dmc || dmc.verificationCode !== String(req.body.verificationCode).toUpperCase().trim()) {
    throw ApiError.notFound('This certificate could not be verified');
  }
  const [result, user, exam] = await Promise.all([Result.findById(dmc.result), User.findById(dmc.student).select('name'), Examination.findById(dmc.examination).select('name')]);
  sendSuccess(res, { valid: true, studentName: user?.name, examination: exam?.name, percentage: result?.percentage, grade: result?.grade, outcome: result?.outcome, issuedAt: dmc.issuedAt });
});
