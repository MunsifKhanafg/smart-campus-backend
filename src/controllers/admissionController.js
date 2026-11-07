import ExaminationAdmission from '../models/ExaminationAdmission.js';
import Examination from '../models/Examination.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import Semester from '../models/Semester.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { getCourseFor, enrolledStudentIds, studentCourseIds } from '../services/accessService.js';
import { evaluateAdmission, loadExamWithPapers } from '../services/admissionService.js';
import { renderAdmitCard } from '../services/pdfService.js';
import { ROLES, EXAM_STATUS, REVIEW_STATUS } from '../config/constants.js';

const loadPublishedExam = async (id) => {
  const exam = await loadExamWithPapers(id);
  if (!exam) throw ApiError.notFound('Examination not found');
  if (exam.status !== EXAM_STATUS.PUBLISHED) throw ApiError.badRequest('This examination is not open for admission yet');
  return exam;
};

// ---------- Student ----------
// Every published examination of the student's semester, with the live state of each requirement.
export const myAdmissions = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile?.semester) return sendSuccess(res, []);
  const exams = await Examination.find({ semester: profile.semester, status: EXAM_STATUS.PUBLISHED }).populate('papers.course', 'code title').sort({ startDate: 1 });
  const admissions = await ExaminationAdmission.find({ student: req.user._id, examination: { $in: exams.map((e) => e._id) } });
  const byExam = new Map(admissions.map((a) => [String(a.examination), a]));

  const rows = [];
  for (const exam of exams) {
    const live = await evaluateAdmission({ studentId: req.user._id, profile, exam });
    rows.push({
      examination: { _id: exam._id, name: exam.name, type: exam.type, startDate: exam.startDate, endDate: exam.endDate },
      admission: byExam.get(String(exam._id)) || null,
      checks: live.checks,
      allPassed: live.allPassed,
      reason: live.reason,
    });
  }
  sendSuccess(res, rows);
});

export const requestAdmission = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile?.semester) throw ApiError.badRequest('You are not placed in a semester yet');
  const exam = await loadPublishedExam(req.body.examination);
  if (String(exam.semester) !== String(profile.semester)) throw ApiError.forbidden('This examination is not for your semester');

  const existing = await ExaminationAdmission.findOne({ student: req.user._id, examination: exam._id });
  if (existing?.status === REVIEW_STATUS.APPROVED) throw ApiError.conflict('Your admission is already approved');

  const live = await evaluateAdmission({ studentId: req.user._id, profile, exam });
  const admission = await ExaminationAdmission.findOneAndUpdate(
    { student: req.user._id, examination: exam._id },
    { $set: { department: profile.department, semester: profile.semester, status: REVIEW_STATUS.PENDING, checks: live.checks, reason: live.reason, requestedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const dept = await Department.findById(profile.department).select('hod');
  if (dept?.hod) await notifyUsers([dept.hod], { title: 'Admission request', message: `${req.user.name} requested admission for ${exam.name}`, type: 'admission', link: '/admissions' });
  sendSuccess(res, admission, 'Admission request sent', 201);
});

// ---------- HOD / head ----------
export const listAdmissions = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  if (req.query.examination) filter.examination = req.query.examination;
  if (req.query.status) filter.status = req.query.status;
  const rows = await ExaminationAdmission.find(filter).populate('examination', 'name type').sort({ requestedAt: -1 }).limit(300).lean();
  const ids = rows.map((r) => r.student);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name').lean(),
    StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean(),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, rows.map((r) => ({ ...r, studentName: name.get(String(r.student)), rollNumber: roll.get(String(r.student)) })));
});

export const reviewAdmission = asyncHandler(async (req, res) => {
  const admission = await ExaminationAdmission.findById(req.params.id);
  if (!admission) throw ApiError.notFound('Admission request not found');
  assertDepartmentAccess(req.user, admission.department);
  const exam = await loadExamWithPapers(admission.examination);
  const profile = await StudentProfile.findOne({ user: admission.student });

  // Re-check the rules right now. Staff cannot approve a student who does not meet them.
  const live = await evaluateAdmission({ studentId: admission.student, profile, exam });
  admission.checks = live.checks;
  if (req.body.status === REVIEW_STATUS.APPROVED && !live.allPassed) {
    await admission.save();
    throw new ApiError(409, `Cannot approve yet. ${live.reason}`, live.checks.filter((c) => !c.passed));
  }
  admission.status = req.body.status;
  admission.remarks = req.body.remarks || '';
  admission.reason = req.body.status === REVIEW_STATUS.APPROVED ? 'Approved. You can download your admit card' : `${req.body.status === REVIEW_STATUS.REJECTED ? 'Rejected' : 'Needs correction'}: ${admission.remarks}`;
  admission.reviewedBy = req.user._id;
  admission.reviewedAt = new Date();
  await admission.save();

  await notifyUsers([admission.student], { title: `Admission ${req.body.status.replace('_', ' ')}`, message: `${exam.name}: ${admission.reason}`, type: 'admission', link: '/exams' });
  logAudit(req, 'admission.review', 'ExaminationAdmission', admission._id, { status: admission.status });
  sendSuccess(res, admission, 'Admission reviewed');
});

// ---------- Admit card ----------
export const downloadAdmitCard = asyncHandler(async (req, res) => {
  const admission = await ExaminationAdmission.findById(req.params.id);
  if (!admission) throw ApiError.notFound('Admission not found');
  if (req.user.role === ROLES.STUDENT) {
    if (String(admission.student) !== String(req.user._id)) throw ApiError.forbidden();
  } else {
    assertDepartmentAccess(req.user, admission.department);
  }
  if (admission.status !== REVIEW_STATUS.APPROVED) throw ApiError.badRequest('The admit card is available only after your admission is approved');
  const exam = await loadPublishedExam(admission.examination);

  const [settings, student, profile, department, semester] = await Promise.all([
    UniversitySettings.getSettings(),
    User.findById(admission.student),
    StudentProfile.findOne({ user: admission.student }),
    Department.findById(admission.department),
    Semester.findById(admission.semester),
  ]);
  // Only the papers of the courses this student takes.
  const mine = (await studentCourseIds(admission.student, admission.semester)).map(String);
  const papers = exam.papers
    .filter((p) => mine.includes(String(p.course._id)))
    .sort((a, b) => a.date - b.date || a.startMinutes - b.startMinutes)
    .map((p) => ({ date: p.date, startTime: p.startTime, endTime: p.endTime, code: p.course.code, title: p.course.title, room: p.room }));
  renderAdmitCard(res, { settings, student, profile, department, semester, exam, papers, admission });
});

// ---------- Teacher: read-only eligibility of the class ----------
export const courseEligibility = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  const exam = await Examination.findById(req.query.examination);
  // The examination must belong to the course's department. Same message either way, so its existence is not revealed.
  if (!exam || String(exam.department) !== String(course.department)) throw ApiError.notFound('Examination not found');
  const ids = await enrolledStudentIds(course._id);
  const [users, profiles, admissions] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name').lean(),
    StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean(),
    ExaminationAdmission.find({ student: { $in: ids }, examination: exam._id }).select('student status').lean(),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  const status = new Map(admissions.map((a) => [String(a.student), a.status]));
  const rows = users
    .map((u) => ({ student: u._id, name: u.name, rollNumber: roll.get(String(u._id)) || '', admission: status.get(String(u._id)) || 'not requested' }))
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));
  sendSuccess(res, { examination: { _id: exam._id, name: exam.name }, rows });
});
