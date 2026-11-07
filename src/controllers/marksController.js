import Examination from '../models/Examination.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import Result from '../models/Result.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { getCourseFor, enrolledStudentIds } from '../services/accessService.js';
import { EXAM_STATUS, MARKS_STATUS, RESULT_STATUS } from '../config/constants.js';

// The examination must be published and must contain a paper for this course.
const loadPaper = async (examId, courseId) => {
  const exam = await Examination.findById(examId);
  if (!exam) throw ApiError.notFound('Examination not found');
  if (exam.status !== EXAM_STATUS.PUBLISHED) throw ApiError.badRequest('The date sheet of this examination is not published');
  const paper = exam.papers.find((p) => String(p.course) === String(courseId));
  if (!paper) throw ApiError.badRequest('This course has no paper in this examination');
  return { exam, paper };
};

// Teacher (or HOD / head, read-only): marks of every enrolled student for one paper.
export const getMarks = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  const { exam, paper } = await loadPaper(req.query.examination, course._id);

  const studentIds = await enrolledStudentIds(course._id);
  const [users, profiles, marks] = await Promise.all([
    User.find({ _id: { $in: studentIds } }).select('name').lean(),
    StudentProfile.find({ user: { $in: studentIds } }).select('user rollNumber').lean(),
    ExaminationMarks.find({ examination: exam._id, course: course._id }).lean(),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  const byStudent = new Map(marks.map((m) => [String(m.student), m]));

  const rows = users
    .map((u) => {
      const m = byStudent.get(String(u._id));
      return { student: u._id, name: u.name, rollNumber: roll.get(String(u._id)) || '', marks: m?.marks ?? null, absent: !!m?.absent, status: m?.status || 'not entered' };
    })
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));

  sendSuccess(res, {
    examination: { _id: exam._id, name: exam.name },
    paper: { _id: paper._id, maxMarks: paper.maxMarks, passingMarks: paper.passingMarks, date: paper.date },
    locked: marks.length > 0 && marks.every((m) => m.status === MARKS_STATUS.SUBMITTED),
    rows,
  });
});

// Save a draft, or save and submit (which locks the marks until the HOD unlocks them).
export const saveMarks = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'write');
  const { exam, paper } = await loadPaper(req.body.examination, course._id);

  if (await Result.exists({ examination: exam._id, status: RESULT_STATUS.PUBLISHED })) {
    throw ApiError.conflict('Results of this examination are published. Marks can no longer be changed');
  }
  const studentIds = (await enrolledStudentIds(course._id)).map(String);
  const existing = await ExaminationMarks.find({ examination: exam._id, course: course._id });
  if (existing.some((m) => m.status === MARKS_STATUS.SUBMITTED)) {
    throw ApiError.conflict('These marks are already submitted and locked. Ask your HOD to unlock them');
  }

  // Merge what is stored with what the teacher just sent, then validate the merged picture.
  const merged = new Map(existing.map((m) => [String(m.student), { marks: m.marks, absent: m.absent }]));
  for (const e of req.body.entries) {
    if (!studentIds.includes(String(e.student))) throw ApiError.badRequest('A listed student is not enrolled in this course');
    const absent = !!e.absent;
    const marks = absent ? null : e.marks ?? null;
    if (marks !== null && marks > paper.maxMarks) throw ApiError.badRequest(`Marks cannot be more than ${paper.maxMarks}`);
    merged.set(String(e.student), { marks, absent });
  }
  if (req.body.submit) {
    const missing = studentIds.filter((id) => {
      const m = merged.get(id);
      return !m || (!m.absent && m.marks === null);
    });
    if (missing.length) throw ApiError.badRequest(`Enter marks (or mark absent) for every student before submitting. ${missing.length} still missing`);
  }

  const status = req.body.submit ? MARKS_STATUS.SUBMITTED : MARKS_STATUS.DRAFT;
  const ids = req.body.submit ? studentIds : req.body.entries.map((e) => String(e.student));
  const ops = ids.map((id) => ({
    updateOne: {
      filter: { examination: exam._id, course: course._id, student: id },
      update: {
        $set: {
          paper: paper._id,
          department: course.department,
          marks: merged.get(id).marks,
          absent: merged.get(id).absent,
          status,
          enteredBy: req.user._id,
          ...(req.body.submit ? { submittedAt: new Date() } : {}),
        },
      },
      upsert: true,
    },
  }));
  await ExaminationMarks.bulkWrite(ops);

  logAudit(req, req.body.submit ? 'marks.submit' : 'marks.save', 'Examination', exam._id, { course: course.code, students: ids.length });
  sendSuccess(res, { saved: ids.length, status }, req.body.submit ? 'Marks submitted and locked' : 'Draft saved');
});

// HOD: reopen submitted marks for correction (only while results are not published).
export const unlockMarks = asyncHandler(async (req, res) => {
  const exam = await Examination.findById(req.body.examination);
  if (!exam) throw ApiError.notFound('Examination not found');
  assertDepartmentAccess(req.user, exam.department);
  if (await Result.exists({ examination: exam._id, status: RESULT_STATUS.PUBLISHED })) {
    throw ApiError.conflict('Results are already published');
  }
  const course = await Course.findById(req.body.course);
  if (!course || String(course.department) !== String(exam.department)) throw ApiError.notFound('Course not found');

  const r = await ExaminationMarks.updateMany({ examination: exam._id, course: course._id }, { status: MARKS_STATUS.DRAFT, $unset: { submittedAt: '' } });
  if (course.teacher) {
    await notifyUsers([course.teacher], { title: 'Marks unlocked', message: `${course.code} marks for ${exam.name} were reopened by your HOD`, type: 'exam', link: `/courses/${course._id}` });
  }
  logAudit(req, 'marks.unlock', 'Examination', exam._id, { course: course.code });
  sendSuccess(res, { unlocked: r.modifiedCount }, 'Marks unlocked');
});
