import Examination from '../models/Examination.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import Result from '../models/Result.js';
import Course from '../models/Course.js';
import Semester from '../models/Semester.js';
import StudentProfile from '../models/StudentProfile.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { dayStart } from '../utils/oid.js';
import { assertNoPaperConflicts } from '../services/examService.js';
import { toMin } from '../models/Examination.js';
import { ROLES, EXAM_STATUS, COURSE_STATUS, CLOSED_SEMESTER_STATES, ENROLLMENT_STATUS } from '../config/constants.js';

const populateExam = (q) =>
  q
    .populate('department', 'name code')
    .populate('semester', 'name number academicYear')
    .populate('papers.course', 'code title section teacher');

const loadExam = async (id) => {
  const exam = await populateExam(Examination.findById(id));
  if (!exam) throw ApiError.notFound('Examination not found');
  return exam;
};

// Everybody who has a stake in the date sheet: enrolled students and the teachers of the papers.
const audienceOf = async (exam) => {
  const courseIds = exam.papers.map((p) => p.course?._id || p.course);
  const students = await CourseEnrollment.find({ course: { $in: courseIds }, status: ENROLLMENT_STATUS.ENROLLED }).distinct('student');
  const teachers = exam.papers.map((p) => p.course?.teacher).filter(Boolean);
  return [...students, ...teachers];
};

const warnIfPublished = async (exam, text) => {
  if (exam.status !== EXAM_STATUS.PUBLISHED) return;
  await notifyUsers(await audienceOf(exam), { title: 'Date sheet updated', message: `${exam.name}: ${text}`, type: 'exam', link: '/exams' });
};

export const listExaminations = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.UNIVERSITY_HEAD) {
    if (req.query.department) filter.department = req.query.department;
  } else {
    filter.department = req.user.department;
  }
  if (req.query.semester) filter.semester = req.query.semester;

  let exams = await populateExam(Examination.find(filter)).sort({ startDate: -1 });
  if (req.user.role === ROLES.TEACHER) {
    // A teacher sees only published sessions, and only the papers of the courses they teach.
    exams = exams
      .filter((e) => e.status === EXAM_STATUS.PUBLISHED)
      .map((e) => {
        const obj = e.toObject();
        obj.papers = obj.papers.filter((p) => String(p.course?.teacher) === String(req.user._id));
        return obj;
      })
      .filter((e) => e.papers.length);
  }
  sendSuccess(res, exams);
});

export const getExamination = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department._id);
  sendSuccess(res, exam);
});

export const createExamination = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.body.semester);
  if (!semester) throw ApiError.notFound('Semester not found');
  assertDepartmentAccess(req.user, semester.department);
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) throw ApiError.badRequest(`Semester is ${semester.status}`);

  const exam = await Examination.create({ ...req.body, department: semester.department, createdBy: req.user._id });
  logAudit(req, 'exam.create', 'Examination', exam._id, { name: exam.name });
  sendSuccess(res, await loadExam(exam._id), 'Examination created', 201);
});

export const updateExamination = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department._id);
  exam.set(req.body);
  await exam.save();
  logAudit(req, 'exam.update', 'Examination', exam._id, { fields: Object.keys(req.body) });
  sendSuccess(res, await loadExam(exam._id), 'Examination updated');
});

const checkPaperRules = async (exam, course, date) => {
  if (String(course.semester) !== String(exam.semester._id)) throw ApiError.badRequest('This course is not part of the examination semester');
  if (course.status !== COURSE_STATUS.ACTIVE) throw ApiError.badRequest('Only active courses can be examined');
  if (date < dayStart(exam.startDate) || date > dayStart(exam.endDate)) throw ApiError.badRequest('Paper date must be inside the examination period');
};

export const addPaper = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department._id);
  const course = await Course.findById(req.body.course);
  if (!course) throw ApiError.notFound('Course not found');
  const date = dayStart(req.body.date);
  await checkPaperRules(exam, course, date);
  if (exam.papers.some((p) => String(p.course._id) === String(course._id))) throw ApiError.conflict('This course already has a paper in this examination');

  const startMinutes = toMin(req.body.startTime);
  const endMinutes = toMin(req.body.endTime);
  await assertNoPaperConflicts({ examination: exam, courseId: course._id, date, startMinutes, endMinutes, room: req.body.room });

  exam.papers.push({ ...req.body, date });
  await exam.save();
  await warnIfPublished(exam, `${course.code} was added`);
  logAudit(req, 'exam.paper_add', 'Examination', exam._id, { course: course.code });
  sendSuccess(res, await loadExam(exam._id), 'Paper added to the date sheet', 201);
});

export const updatePaper = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department._id);
  const paper = exam.papers.id(req.params.paperId);
  if (!paper) throw ApiError.notFound('Paper not found');

  const next = {
    date: req.body.date ? dayStart(req.body.date) : paper.date,
    startTime: req.body.startTime ?? paper.startTime,
    endTime: req.body.endTime ?? paper.endTime,
    room: req.body.room ?? paper.room,
  };
  if (toMin(next.endTime) <= toMin(next.startTime)) throw ApiError.badRequest('End time must be after the start time');
  const fullCourse = await Course.findById(paper.course._id);
  await checkPaperRules(exam, fullCourse, next.date);
  await assertNoPaperConflicts({
    examination: exam,
    courseId: paper.course._id,
    date: next.date,
    startMinutes: toMin(next.startTime),
    endMinutes: toMin(next.endTime),
    room: next.room,
    excludePaperId: paper._id,
  });

  if ((req.body.maxMarks !== undefined || req.body.passingMarks !== undefined) && (await ExaminationMarks.exists({ examination: exam._id, paper: paper._id }))) {
    throw ApiError.conflict('Marks were already entered for this paper, so its marks scheme cannot change');
  }
  paper.set({ ...req.body, ...next });
  await exam.save();
  await warnIfPublished(exam, `${paper.course.code} was rescheduled`);
  logAudit(req, 'exam.paper_update', 'Examination', exam._id, { paper: String(paper._id) });
  sendSuccess(res, await loadExam(exam._id), 'Paper updated');
});

export const removePaper = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department._id);
  const paper = exam.papers.id(req.params.paperId);
  if (!paper) throw ApiError.notFound('Paper not found');
  if (await ExaminationMarks.exists({ examination: exam._id, paper: paper._id })) {
    throw ApiError.conflict('Marks were already entered for this paper and it cannot be removed');
  }
  const code = paper.course.code;
  paper.deleteOne();
  await exam.save();
  await warnIfPublished(exam, `${code} was removed`);
  sendSuccess(res, await loadExam(exam._id), 'Paper removed');
});

export const publishExamination = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department._id);
  if (exam.status === EXAM_STATUS.PUBLISHED) throw ApiError.conflict('Already published');
  if (!exam.papers.length) throw ApiError.badRequest('Add at least one paper before publishing');

  exam.status = EXAM_STATUS.PUBLISHED;
  exam.publishedAt = new Date();
  await exam.save();
  await notifyUsers(await audienceOf(exam), {
    title: 'Examination date sheet published',
    message: `${exam.name} (${exam.semester.name})`,
    type: 'exam',
    link: '/exams',
  });
  logAudit(req, 'exam.publish', 'Examination', exam._id, { name: exam.name });
  sendSuccess(res, exam, 'Date sheet published');
});

export const unpublishExamination = asyncHandler(async (req, res) => {
  const exam = await loadExam(req.params.id);
  assertDepartmentAccess(req.user, exam.department._id);
  if (await ExaminationMarks.exists({ examination: exam._id })) throw ApiError.conflict('Marks were already entered. The date sheet cannot be withdrawn');
  if (await Result.exists({ examination: exam._id })) throw ApiError.conflict('Results exist for this examination');
  exam.status = EXAM_STATUS.DRAFT;
  await exam.save();
  logAudit(req, 'exam.unpublish', 'Examination', exam._id);
  sendSuccess(res, exam, 'Date sheet moved back to draft');
});

// Student: published date sheets of the semester they are in, limited to the papers of courses they take.
export const myDatesheet = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id }).select('semester');
  if (!profile?.semester) return sendSuccess(res, []);
  const courseIds = (await CourseEnrollment.find({ student: req.user._id, status: ENROLLMENT_STATUS.ENROLLED, semester: profile.semester }).distinct('course')).map(String);

  const exams = await populateExam(Examination.find({ semester: profile.semester, status: EXAM_STATUS.PUBLISHED })).sort({ startDate: 1 });
  sendSuccess(res, exams.map((e) => {
    const obj = e.toObject();
    obj.papers = obj.papers
      .filter((p) => courseIds.includes(String(p.course?._id)))
      .sort((a, b) => a.date - b.date || a.startMinutes - b.startMinutes)
      .map((p) => ({ _id: p._id, course: { code: p.course.code, title: p.course.title }, date: p.date, startTime: p.startTime, endTime: p.endTime, room: p.room, maxMarks: p.maxMarks }));
    return obj;
  }));
});
