import Assignment from '../models/Assignment.js';
import Submission from '../models/Submission.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { getCourseFor, enrolledStudentIds } from '../services/accessService.js';
import { toFileDocs, removeStored, sendStored } from '../middleware/upload.js';
import { ROLES } from '../config/constants.js';

const pub = (f) => ({ originalName: f.originalName, storedName: f.storedName, mimeType: f.mimeType, size: f.size });

// Teacher's view of the time line: upcoming -> active -> expired.
export const assignmentPhase = (a, now = new Date()) => (now < a.releaseDate ? 'upcoming' : now <= a.deadline ? 'active' : 'expired');

const loadAssignment = async (id) => {
  const a = await Assignment.findById(id);
  if (!a) throw ApiError.notFound('Assignment not found');
  return a;
};

const staffShape = (a, extra = {}) => ({ ...a.toObject(), attachments: a.attachments.map(pub), phase: assignmentPhase(a), ...extra });

const submissionShape = (s) =>
  s && {
    _id: s._id,
    text: s.text,
    files: s.files.map(pub),
    submittedAt: s.submittedAt,
    isLate: s.isLate,
    marks: s.marks,
    feedback: s.feedback,
    gradedAt: s.gradedAt,
  };

// Student's view. Before the release date only title and dates are visible.
// status: upcoming | active | expired | completed (the student already submitted)
const studentShape = (a, submission) => {
  const phase = assignmentPhase(a);
  const base = { _id: a._id, course: a.course, type: a.type, title: a.title, releaseDate: a.releaseDate, deadline: a.deadline, maxMarks: a.maxMarks };
  if (phase === 'upcoming') return { ...base, status: 'upcoming' };
  return {
    ...base,
    description: a.description,
    instructions: a.instructions,
    allowLateSubmission: a.allowLateSubmission,
    attachments: a.attachments.map(pub),
    status: submission ? 'completed' : phase,
    submission: submissionShape(submission),
  };
};

export const listAssignments = asyncHandler(async (req, res) => {
  await getCourseFor(req.user, req.query.course, 'any');
  const assignments = await Assignment.find({ course: req.query.course }).sort({ deadline: 1 });

  if (req.user.role === ROLES.STUDENT) {
    const subs = await Submission.find({ student: req.user._id, assignment: { $in: assignments.map((a) => a._id) } });
    const byAssignment = new Map(subs.map((s) => [String(s.assignment), s]));
    return sendSuccess(res, assignments.map((a) => studentShape(a, byAssignment.get(String(a._id)))));
  }

  const counts = await Submission.aggregate([
    { $match: { assignment: { $in: assignments.map((a) => a._id) } } },
    { $group: { _id: '$assignment', submitted: { $sum: 1 }, graded: { $sum: { $cond: [{ $ne: ['$marks', null] }, 1, 0] } }, late: { $sum: { $cond: ['$isLate', 1, 0] } } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c]));
  sendSuccess(res, assignments.map((a) => {
    const c = byId.get(String(a._id));
    return staffShape(a, { submitted: c?.submitted || 0, graded: c?.graded || 0, late: c?.late || 0 });
  }));
});

export const getAssignment = asyncHandler(async (req, res) => {
  const a = await loadAssignment(req.params.id);
  await getCourseFor(req.user, a.course, 'any');
  if (req.user.role !== ROLES.STUDENT) return sendSuccess(res, staffShape(a));
  const sub = await Submission.findOne({ assignment: a._id, student: req.user._id });
  sendSuccess(res, studentShape(a, sub));
});

export const createAssignment = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.body.course, 'write');
  const a = await Assignment.create({
    ...req.body,
    course: course._id,
    department: course.department,
    semester: course.semester._id,
    createdBy: req.user._id,
  });
  await notifyUsers(await enrolledStudentIds(course._id), {
    title: `New ${a.type}: ${a.title}`,
    message: `${course.code} - available from ${a.releaseDate.toDateString()}, due ${a.deadline.toDateString()}`,
    type: 'assignment',
    link: `/my-courses/${course._id}`,
  });
  logAudit(req, 'assignment.create', 'Assignment', a._id, { course: course.code, title: a.title });
  sendSuccess(res, staffShape(a), 'Assignment created', 201);
});

export const updateAssignment = asyncHandler(async (req, res) => {
  const a = await loadAssignment(req.params.id);
  await getCourseFor(req.user, a.course, 'write');
  const hasSubs = await Submission.exists({ assignment: a._id });
  if (hasSubs && req.body.maxMarks !== undefined && req.body.maxMarks !== a.maxMarks) {
    throw ApiError.badRequest('Maximum marks cannot change after students have submitted');
  }
  a.set(req.body);
  // The edit schema is partial, so it cannot compare the two dates. Check the final values here.
  if (a.deadline <= a.releaseDate) throw ApiError.badRequest('Deadline must be after the release date');
  await a.save();
  logAudit(req, 'assignment.update', 'Assignment', a._id, { fields: Object.keys(req.body) });
  sendSuccess(res, staffShape(a), 'Assignment updated');
});

export const deleteAssignment = asyncHandler(async (req, res) => {
  const a = await loadAssignment(req.params.id);
  await getCourseFor(req.user, a.course, 'write');
  if (await Submission.exists({ assignment: a._id })) throw ApiError.conflict('This assignment already has submissions and cannot be deleted');
  removeStored('assignments', a.attachments);
  await a.deleteOne();
  logAudit(req, 'assignment.delete', 'Assignment', a._id);
  sendSuccess(res, null, 'Assignment deleted');
});

export const addAttachments = uploadHandler(async (req, res) => {
  const a = await loadAssignment(req.params.id);
  await getCourseFor(req.user, a.course, 'write');
  if (!req.files?.length) throw ApiError.badRequest('Please choose at least one file');
  a.attachments.push(...toFileDocs(req.files));
  await a.save();
  sendSuccess(res, staffShape(a), 'Files attached', 201);
});

export const downloadAttachment = asyncHandler(async (req, res) => {
  const a = await loadAssignment(req.params.id);
  await getCourseFor(req.user, a.course, 'any');
  if (req.user.role === ROLES.STUDENT && assignmentPhase(a) === 'upcoming') throw ApiError.forbidden('This assignment is not available yet');
  const file = a.attachments.find((f) => f.storedName === req.params.storedName);
  if (!file) throw ApiError.notFound('File not found');
  sendStored(res, 'assignments', file);
});

// ---------- Student submits ----------
export const submitAssignment = uploadHandler(async (req, res) => {
  const a = await loadAssignment(req.params.id);
  await getCourseFor(req.user, a.course, 'any');
  const now = new Date();

  const phase = assignmentPhase(a, now);
  if (phase === 'upcoming') throw ApiError.badRequest('This assignment is not open yet');
  const isLate = phase === 'expired';
  if (isLate && !a.allowLateSubmission) throw ApiError.badRequest('The deadline has passed and late submissions are not accepted');

  const files = toFileDocs(req.files || []);
  const text = req.body.text || '';
  if (!files.length && !text.trim()) throw ApiError.badRequest('Add some text or at least one file');

  let sub = await Submission.findOne({ assignment: a._id, student: req.user._id });
  if (sub?.gradedAt) throw ApiError.conflict('This submission has already been marked and can no longer be changed');

  if (sub) {
    removeStored('submissions', sub.files); // re-submitting replaces the earlier files
    sub.set({ text, files, submittedAt: now, isLate });
  } else {
    sub = new Submission({ assignment: a._id, course: a.course, student: req.user._id, text, files, submittedAt: now, isLate });
  }
  await sub.save();
  sendSuccess(res, submissionShape(sub), isLate ? 'Submitted (marked as late)' : 'Submitted', 201);
});

// ---------- Teacher reviews ----------
export const listSubmissions = asyncHandler(async (req, res) => {
  const a = await loadAssignment(req.params.id);
  await getCourseFor(req.user, a.course, 'staff');

  const studentIds = await enrolledStudentIds(a.course);
  const [users, profiles, subs] = await Promise.all([
    User.find({ _id: { $in: studentIds } }).select('name email').lean(),
    StudentProfile.find({ user: { $in: studentIds } }).select('user rollNumber').lean(),
    Submission.find({ assignment: a._id }),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  const subBy = new Map(subs.map((s) => [String(s.student), s]));
  const expired = assignmentPhase(a) === 'expired';

  const rows = users
    .map((u) => {
      const s = subBy.get(String(u._id));
      return {
        student: { _id: u._id, name: u.name, rollNumber: roll.get(String(u._id)) || '' },
        status: s ? (s.isLate ? 'late' : 'submitted') : expired ? 'missing' : 'pending',
        submission: submissionShape(s),
      };
    })
    .sort((x, y) => x.student.rollNumber.localeCompare(y.student.rollNumber));
  sendSuccess(res, { assignment: staffShape(a), rows });
});

export const gradeSubmission = asyncHandler(async (req, res) => {
  const sub = await Submission.findById(req.params.id);
  if (!sub) throw ApiError.notFound('Submission not found');
  const a = await loadAssignment(sub.assignment);
  await getCourseFor(req.user, a.course, 'write');
  if (req.body.marks > a.maxMarks) throw ApiError.badRequest(`Marks cannot be more than ${a.maxMarks}`);

  sub.marks = req.body.marks;
  sub.feedback = req.body.feedback || '';
  sub.gradedAt = new Date();
  sub.gradedBy = req.user._id;
  await sub.save();

  await notifyUsers([sub.student], {
    title: `Marks posted: ${a.title}`,
    message: `You scored ${sub.marks} / ${a.maxMarks}`,
    type: 'assignment',
    link: `/my-courses/${a.course}`,
  });
  logAudit(req, 'submission.grade', 'Submission', sub._id, { marks: sub.marks });
  sendSuccess(res, submissionShape(sub), 'Marks saved');
});

// Owner of the submission or the staff of that course.
export const downloadSubmissionFile = asyncHandler(async (req, res) => {
  const sub = await Submission.findById(req.params.id);
  if (!sub) throw ApiError.notFound('Submission not found');
  if (req.user.role === ROLES.STUDENT) {
    if (String(sub.student) !== String(req.user._id)) throw ApiError.forbidden();
  } else {
    await getCourseFor(req.user, sub.course, 'staff');
  }
  const file = sub.files.find((f) => f.storedName === req.params.storedName);
  if (!file) throw ApiError.notFound('File not found');
  sendStored(res, 'submissions', file);
});
