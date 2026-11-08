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
import { smsToUser } from '../services/smsService.js';
import { resolvePhone } from '../services/requirementService.js';
import { ROLES, EXAM_STATUS, REVIEW_STATUS } from '../config/constants.js';

const loadPublishedExam = async (id) => {
  const exam = await loadExamWithPapers(id);
  if (!exam) throw ApiError.notFound('Examination not found');
  if (exam.status !== EXAM_STATUS.PUBLISHED) throw ApiError.badRequest('This examination is not open for admission yet');
  return exam;
};

// ---------- Student ----------
// Every published examination of the student's semester, with the live state of each requirement.
// Every published examination of one student's semester, with the live state of each requirement.
// Used by the student (My exams) and by the finance office (applying for a student at the counter).
const admissionRows = async (studentId, profile) => {
  if (!profile?.semester) return [];
  const exams = await Examination.find({ semester: profile.semester, status: EXAM_STATUS.PUBLISHED }).populate('papers.course', 'code title').sort({ startDate: 1 });
  const admissions = await ExaminationAdmission.find({ student: studentId, examination: { $in: exams.map((e) => e._id) } });
  const byExam = new Map(admissions.map((a) => [String(a.examination), a]));

  const rows = [];
  for (const exam of exams) {
    const live = await evaluateAdmission({ studentId, profile, exam });
    rows.push({
      examination: { _id: exam._id, name: exam.name, type: exam.type, startDate: exam.startDate, endDate: exam.endDate },
      admission: byExam.get(String(exam._id)) || null,
      checks: live.checks,
      allPassed: live.allPassed,
      reason: live.reason,
    });
  }
  return rows;
};

export const myAdmissions = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  sendSuccess(res, await admissionRows(req.user._id, profile));
});

// Creates (or reopens) the admission request. The student asks online, or the office asks for a student who cannot.
// Either way the HOD still reviews it and the server re-checks every rule at approval.
const submitRequest = async ({ student, profile, examId, requestedBy = null }) => {
  if (!profile?.semester) throw ApiError.badRequest('The student is not placed in a semester yet');
  const exam = await loadPublishedExam(examId);
  if (String(exam.semester) !== String(profile.semester)) throw ApiError.forbidden('This examination is not for the student\'s semester');

  const existing = await ExaminationAdmission.findOne({ student: student._id, examination: exam._id });
  if (existing?.status === REVIEW_STATUS.APPROVED) throw ApiError.conflict('The admission is already approved');

  const live = await evaluateAdmission({ studentId: student._id, profile, exam });
  const admission = await ExaminationAdmission.findOneAndUpdate(
    { student: student._id, examination: exam._id },
    { $set: { department: profile.department, semester: profile.semester, status: REVIEW_STATUS.PENDING, checks: live.checks, reason: live.reason, requestedAt: new Date(), requestedBy, atOffice: !!requestedBy } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const dept = await Department.findById(profile.department).select('hod');
  if (dept?.hod && String(dept.hod) !== String(requestedBy)) {
    await notifyUsers([dept.hod], { title: 'Admission request', message: `${student.name} requested admission for ${exam.name}${requestedBy ? ' (applied at the office)' : ''}`, type: 'admission', link: '/admissions' });
  }
  return { admission, exam };
};

export const requestAdmission = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  const { admission } = await submitRequest({ student: req.user, profile, examId: req.body.examination });
  sendSuccess(res, admission, 'Admission request sent', 201);
});

// ---------- Finance office / HOD: for a student who comes to the office ----------
// A student without an online account (or who cannot use it) pays at the office. The office also applies for the exam
// admission, so the student never has to log in. An HOD can do this for students of their own department only.
const loadStudentFor = async (user, studentId) => {
  const [profile, student] = await Promise.all([StudentProfile.findOne({ user: studentId }), User.findById(studentId).select('name')]);
  if (!profile || !student) throw ApiError.notFound('Student not found');
  if (user.role === ROLES.HOD) assertDepartmentAccess(user, profile.department);
  return { student, profile };
};

export const studentAdmissions = asyncHandler(async (req, res) => {
  const { profile } = await loadStudentFor(req.user, req.params.id);
  sendSuccess(res, await admissionRows(req.params.id, profile));
});

export const requestAdmissionFor = asyncHandler(async (req, res) => {
  const { student, profile } = await loadStudentFor(req.user, req.body.student);
  // The office types the student's mobile number at the counter. It is saved on the account, so the SMS below reaches the student.
  if (req.body.phone) await resolvePhone(student._id, req.body.phone);
  const { admission, exam } = await submitRequest({ student, profile, examId: req.body.examination, requestedBy: req.user._id });
  await notifyUsers([student._id], { title: 'Examination admission requested', message: `The office applied for your admission to ${exam.name}. You can follow it under Examinations.`, type: 'admission', link: '/exams' });
  const smsStatus = await smsToUser(student._id, `Admission request for ${exam.name} (Roll No ${profile.rollNumber}) was submitted by the university office. You will get an SMS when the HOD decides.`);
  logAudit(req, 'admission.request_for', 'ExaminationAdmission', admission._id, { student: String(student._id), by: req.user.name });
  sendSuccess(res, { ...admission.toObject(), smsStatus }, 'Admission requested for the student. The HOD will review it', 201);
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
  // A student who applied at the office may never log in, so the decision is also sent by SMS.
  if (admission.atOffice) {
    const decision = req.body.status === REVIEW_STATUS.APPROVED ? 'approved. Collect your admit card at the university office' : `${req.body.status === REVIEW_STATUS.REJECTED ? 'rejected' : 'needs correction'}. ${admission.remarks}`;
    await smsToUser(admission.student, `${exam.name} (Roll No ${profile?.rollNumber || '-'}): admission ${decision}`);
  }
  logAudit(req, 'admission.review', 'ExaminationAdmission', admission._id, { status: admission.status });
  sendSuccess(res, admission, 'Admission reviewed');
});

// ---------- Admit card ----------
export const downloadAdmitCard = asyncHandler(async (req, res) => {
  const admission = await ExaminationAdmission.findById(req.params.id);
  if (!admission) throw ApiError.notFound('Admission not found');
  if (req.user.role === ROLES.STUDENT) {
    if (String(admission.student) !== String(req.user._id)) throw ApiError.forbidden();
  } else if (req.user.role !== ROLES.FINANCE_OFFICER) {
    // The finance office prints the admit card for a student who applied at the counter.
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
