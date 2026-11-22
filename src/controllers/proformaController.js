import MarksProforma from '../models/MarksProforma.js';
import ProformaSubmission from '../models/ProformaSubmission.js';
import UniversitySettings from '../models/UniversitySettings.js';
import User from '../models/User.js';
import Course from '../models/Course.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { getCourseFor, enrolledStudentIds } from '../services/accessService.js';
import { buildSheet, suggestMarks, COMPONENTS, KEYS } from '../services/proformaService.js';
import { renderTableReport } from '../services/pdfService.js';
import { buildXlsx, XLSX_MIME } from '../services/xlsxBuilder.js';
import { MARKS_STATUS, ROLES } from '../config/constants.js';

const shown = (v) => (v === null || v === undefined ? '-' : v);
const safeName = (s) => String(s || 'proforma').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

// ---------------------------------------------------------------------------------------------
// Files: the same sheet as PDF and as Excel. The numbers always come from buildSheet (the server calculates totals and grades).
// ---------------------------------------------------------------------------------------------
const infoPairs = (sheet) => [
  ['Department', sheet.department ? `${sheet.department.name} (${sheet.department.code})` : '-'],
  ['Semester', sheet.semester ? `${sheet.semester.name} (${sheet.semester.academicYear})` : '-'],
  ['Subject', `${sheet.course.code} - ${sheet.course.title}`],
  ['Section / credit hours', `${sheet.course.section || '-'} / ${sheet.course.creditHours}`],
  ['Teacher', sheet.teacher?.name || '-'],
  ['Passing marks', `${sheet.passingPercentage} out of 100`],
];

const summaryPairs = (sheet) => {
  const s = sheet.summary;
  return [
    ['Students', `${s.students} (${s.complete} complete, ${s.pending} pending)`],
    ['Passed / failed', `${s.passed} / ${s.failed}`],
    ['Average / highest / lowest', s.average === null ? '-' : `${s.average} / ${s.highest} / ${s.lowest}`],
  ];
};

export const sendPdf = async (res, sheet, note = '') => {
  const settings = await UniversitySettings.getSettings();
  const draft = !sheet.locked && !note;
  renderTableReport(res, {
    settings,
    title: `MARKS PROFORMA${draft ? ' (DRAFT)' : ''}`,
    filename: `Proforma-${safeName(sheet.course.code)}-${safeName(sheet.semester?.name)}.pdf`,
    generated: `Generated ${new Date(sheet.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC${note ? ` · ${note}` : ''}`,
    summary: [...infoPairs(sheet), ...summaryPairs(sheet)],
    columns: [
      { label: 'Roll no', width: 52 }, { label: 'Student', width: 110 },
      { label: 'Assign. (5)', width: 34 }, { label: 'Quiz (5)', width: 30 }, { label: 'Attend. (5)', width: 34 }, { label: 'Present. (5)', width: 34 },
      { label: 'Mid (20)', width: 32 }, { label: 'Internal (40)', width: 38 }, { label: 'Final (60)', width: 34 },
      { label: 'Total (100)', width: 38 }, { label: 'Grade', width: 28 }, { label: 'Result', width: 32 },
    ],
    rows: sheet.rows.map((r) => [r.rollNumber, r.name, shown(r.assignment), shown(r.quiz), shown(r.attendance), shown(r.presentation), shown(r.midterm), r.internal, shown(r.finalTerm), r.total, r.grade, r.result]),
  });
};

export const sendXlsx = async (res, sheet, note = '') => {
  const settings = await UniversitySettings.getSettings();
  const head = ['Roll no', 'Student', ...COMPONENTS.slice(0, 5).map((c) => `${c.label} (${c.max})`), 'Internal (40)', 'Final Term (60)', 'Total (100)', 'Grade', 'Result'];
  const rows = [
    [{ v: settings.universityName, style: 5 }],
    [{ v: `${settings.campusName || ''}`, bold: true }],
    [{ v: `MARKS PROFORMA${!sheet.locked && !note ? ' (DRAFT)' : ''}${note ? ` - ${note}` : ''}`, bold: true }],
    [],
    ...infoPairs(sheet).map(([k, v]) => [{ v: k, bold: true }, v]),
    ...summaryPairs(sheet).map(([k, v]) => [{ v: k, bold: true }, v]),
    [],
    head.map((h) => ({ v: h, style: 2 })),
    ...sheet.rows.map((r) => [
      { v: r.rollNumber, style: 3 }, { v: r.name, style: 3 },
      ...[r.assignment, r.quiz, r.attendance, r.presentation, r.midterm].map((x) => ({ v: x === null ? '' : x, style: 4 })),
      { v: r.internal, style: 4 }, { v: r.finalTerm === null ? '' : r.finalTerm, style: 4 }, { v: r.total, style: 4 }, { v: r.grade, style: 4 }, { v: r.result, style: 4 },
    ]),
  ];
  const buf = await buildXlsx({ sheetName: sheet.course.code, rows, widths: [16, 30, 12, 10, 12, 14, 10, 13, 14, 12, 8, 10] });
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="Proforma-${safeName(sheet.course.code)}-${safeName(sheet.semester?.name)}.xlsx"`);
  res.send(buf);
};

const sendFile = (res, format, sheet, note) => {
  if (format === 'pdf') return sendPdf(res, sheet, note);
  if (format === 'xlsx') return sendXlsx(res, sheet, note);
  throw ApiError.badRequest('Format must be pdf or xlsx');
};

// ---------------------------------------------------------------------------------------------
// One subject: the teacher enters marks, everyone concerned can look.
// ---------------------------------------------------------------------------------------------
export const getSheet = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  const sheet = await buildSheet(course._id);
  const isTeacher = req.user.role === ROLES.TEACHER;
  sendSuccess(res, { ...sheet, canEdit: isTeacher && !sheet.locked, canSubmit: isTeacher && !sheet.locked && sheet.summary.students > 0, canUnlock: req.user.role === ROLES.HOD && sheet.locked });
});

export const getSuggestions = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'write');
  const [settings, ids] = await Promise.all([UniversitySettings.getSettings(), enrolledStudentIds(course._id)]);
  sendSuccess(res, await suggestMarks(course, ids, settings));
});

export const saveRows = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'write');
  const enrolled = new Set((await enrolledStudentIds(course._id)).map(String));
  if (await MarksProforma.exists({ course: course._id, status: MARKS_STATUS.SUBMITTED })) {
    throw ApiError.conflict('This proforma was sent to the office and is locked. Ask your HOD to unlock it');
  }
  const ops = req.body.rows.map((r) => {
    if (!enrolled.has(String(r.student))) throw ApiError.badRequest('A listed student is not enrolled in this course');
    const set = { semester: course.semester._id || course.semester, department: course.department, enteredBy: req.user._id, status: MARKS_STATUS.DRAFT };
    for (const c of COMPONENTS) {
      if (r[c.key] === undefined) continue;
      if (r[c.key] !== null && (r[c.key] < 0 || r[c.key] > c.max)) throw ApiError.badRequest(`${c.label} marks must be between 0 and ${c.max}`);
      set[c.key] = r[c.key];
    }
    return { updateOne: { filter: { course: course._id, student: r.student }, update: { $set: set }, upsert: true } };
  });
  if (ops.length) await MarksProforma.bulkWrite(ops);
  logAudit(req, 'proforma.save', 'Course', course._id, { course: course.code, students: ops.length });
  sendSuccess(res, await buildSheet(course._id), 'Marks saved');
});

export const exportCourse = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  await sendFile(res, req.params.format, await buildSheet(course._id));
});

export const submitProforma = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'write');
  const sheet = await buildSheet(course._id);
  if (sheet.locked) throw ApiError.conflict('This proforma is already sent. Ask your HOD to unlock it if a correction is needed');
  if (!sheet.summary.students) throw ApiError.badRequest('No student is enrolled in this course');
  if (sheet.summary.pending) throw ApiError.badRequest(`Enter all six marks for every student first. ${sheet.summary.pending} student(s) are still incomplete`);

  const last = await ProformaSubmission.findOne({ course: course._id }).sort({ version: -1 }).select('version').lean();
  const version = (last?.version || 0) + 1;
  const { lastSubmission, ...snapshot } = sheet;
  const submission = await ProformaSubmission.create({
    course: course._id, semester: course.semester._id || course.semester, department: course.department, teacher: req.user._id,
    recipients: req.body.recipients, note: req.body.note || '', version, summary: sheet.summary, snapshot: { ...snapshot, locked: true, submittedAt: new Date().toISOString(), version },
  });
  await MarksProforma.updateMany({ course: course._id }, { status: MARKS_STATUS.SUBMITTED, submittedAt: new Date() });

  const to = [];
  if (req.body.recipients.includes('principal')) to.push(...(await User.find({ role: ROLES.UNIVERSITY_HEAD, isActive: true }).distinct('_id')));
  if (req.body.recipients.includes('examination')) to.push(...(await User.find({ role: ROLES.HOD, department: course.department, isActive: true }).distinct('_id')));
  await notifyUsers(to, {
    title: 'Marks proforma received',
    message: `${req.user.name} sent the marks proforma of ${course.code} - ${course.title} (version ${version}).`,
    type: 'exam',
    link: `/proformas?open=${submission._id}`,
  });
  logAudit(req, 'proforma.submit', 'ProformaSubmission', submission._id, { course: course.code, version, recipients: req.body.recipients });
  sendSuccess(res, { _id: submission._id, version }, 'Proforma sent. The marks are now locked', 201);
});

export const unlockProforma = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.courseId);
  if (!course) throw ApiError.notFound('Course not found');
  assertDepartmentAccess(req.user, course.department);
  const r = await MarksProforma.updateMany({ course: course._id }, { status: MARKS_STATUS.DRAFT, $unset: { submittedAt: '' } });
  if (course.teacher) await notifyUsers([course.teacher], { title: 'Proforma unlocked', message: `Your HOD reopened the marks proforma of ${course.code} for correction. Send it again afterwards (a new version).`, type: 'exam', link: `/courses/${course._id}` });
  logAudit(req, 'proforma.unlock', 'Course', course._id, { course: course.code });
  sendSuccess(res, { unlocked: r.modifiedCount }, 'Proforma unlocked');
});

// ---------------------------------------------------------------------------------------------
// What was sent to the office (snapshots). Principal: everything. HOD: the own department. Teacher: the own.
// ---------------------------------------------------------------------------------------------
const submissionScope = (user) => {
  if (user.role === ROLES.HOD) return { department: user.department };
  if (user.role === ROLES.TEACHER) return { teacher: user._id };
  return {};
};
const loadSubmission = async (user, id) => {
  const s = await ProformaSubmission.findOne({ _id: id, ...submissionScope(user) });
  if (!s) throw ApiError.notFound('Proforma not found');
  return s;
};

export const listSubmissions = asyncHandler(async (req, res) => {
  const filter = { ...submissionScope(req.user) };
  if (req.query.department && req.user.role === ROLES.UNIVERSITY_HEAD) filter.department = req.query.department;
  if (req.query.semester) filter.semester = req.query.semester;
  const rows = await ProformaSubmission.find(filter)
    .select('-snapshot')
    .populate('course', 'code title section')
    .populate('semester', 'name academicYear')
    .populate('department', 'name code')
    .populate('teacher', 'name')
    .populate('receivedBy.user', 'name')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  sendSuccess(res, rows);
});

export const getSubmission = asyncHandler(async (req, res) => {
  const s = await loadSubmission(req.user, req.params.id);
  sendSuccess(res, { _id: s._id, version: s.version, note: s.note, recipients: s.recipients, receivedBy: s.receivedBy, createdAt: s.createdAt, sheet: s.snapshot });
});

export const exportSubmission = asyncHandler(async (req, res) => {
  const s = await loadSubmission(req.user, req.params.id);
  await sendFile(res, req.params.format, s.snapshot, `version ${s.version} sent ${new Date(s.createdAt).toISOString().slice(0, 10)}`);
});

// The principal (as "principal") or the HOD (as the Examination Department) confirms that the proforma was received.
export const receiveSubmission = asyncHandler(async (req, res) => {
  const s = await loadSubmission(req.user, req.params.id);
  const as = req.user.role === ROLES.UNIVERSITY_HEAD ? 'principal' : 'examination';
  if (!s.recipients.includes(as)) throw ApiError.badRequest('This proforma was not addressed to you');
  if (!s.receivedBy.some((r) => r.as === as)) {
    s.receivedBy.push({ user: req.user._id, as, at: new Date() });
    await s.save();
    await notifyUsers([s.teacher], { title: 'Proforma received', message: `${req.user.name} confirmed receipt of the marks proforma (version ${s.version}).`, type: 'exam', link: `/courses/${s.course}` });
  }
  sendSuccess(res, null, 'Marked as received');
});

export { KEYS };
