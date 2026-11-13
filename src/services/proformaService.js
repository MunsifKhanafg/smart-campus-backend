import Course from '../models/Course.js';
import Semester from '../models/Semester.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import UniversitySettings from '../models/UniversitySettings.js';
import Attendance from '../models/Attendance.js';
import Quiz from '../models/Quiz.js';
import QuizAttempt from '../models/QuizAttempt.js';
import Assignment from '../models/Assignment.js';
import Submission from '../models/Submission.js';
import Examination from '../models/Examination.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import MarksProforma from '../models/MarksProforma.js';
import ProformaSubmission from '../models/ProformaSubmission.js';
import { ApiError } from '../utils/apiHelpers.js';
import { round2 } from '../utils/oid.js';
import { enrolledStudentIds } from './accessService.js';
import { gradeFor } from './gradingService.js';
import { ATTENDANCE_STATUS, ATTEMPT_STATUS, EXAM_STATUS, MARKS_STATUS, QUIZ_STATUS } from '../config/constants.js';

// ===== Marks proforma logic. Plain code only: AI is NEVER involved in marks, grades or pass/fail. =====
// Every subject carries 100 marks: 40 internal (teacher) + 60 final term.

export const COMPONENTS = Object.freeze([
  { key: 'assignment', label: 'Assignment', max: 5, internal: true },
  { key: 'quiz', label: 'Quiz', max: 5, internal: true },
  { key: 'attendance', label: 'Attendance', max: 5, internal: true },
  { key: 'presentation', label: 'Presentation', max: 5, internal: true },
  { key: 'midterm', label: 'Midterm', max: 20, internal: true },
  { key: 'finalTerm', label: 'Final Term', max: 60, internal: false },
]);
export const KEYS = COMPONENTS.map((c) => c.key);
export const INTERNAL_KEYS = COMPONENTS.filter((c) => c.internal).map((c) => c.key);
export const INTERNAL_MAX = INTERNAL_KEYS.reduce((s, k) => s + COMPONENTS.find((c) => c.key === k).max, 0); // 40
export const TOTAL_MAX = COMPONENTS.reduce((s, c) => s + c.max, 0); // 100

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const clamp = (v, max) => (v === null ? null : Math.max(0, Math.min(max, round2(v))));
const maxOf = (key) => COMPONENTS.find((c) => c.key === key).max;

const plainRules = (settings) => settings.gradingRules.map((r) => ({ grade: r.grade, minPercentage: r.minPercentage, gpaPoints: r.gpaPoints }));

// Internal total, grand total (out of 100), grade and result of ONE row. A row is "complete" only when all six parts are entered.
// Because the total is out of 100, the total IS the percentage, so the university grading rules apply to it directly.
// As in the official result calculation, a failed student gets the lowest grade.
export const computeRow = (row, settings) => {
  const v = {};
  for (const k of KEYS) v[k] = num(row[k]);
  const internal = round2(INTERNAL_KEYS.reduce((s, k) => s + (v[k] ?? 0), 0));
  const internalComplete = INTERNAL_KEYS.every((k) => v[k] !== null);
  const complete = internalComplete && v.finalTerm !== null;
  const total = round2(internal + (v.finalTerm ?? 0));
  let grade = '-';
  let result = 'Pending';
  let passed = null;
  if (complete) {
    const rules = plainRules(settings);
    passed = total >= settings.passingPercentage;
    const lowest = [...rules].sort((a, b) => a.minPercentage - b.minPercentage)[0];
    grade = (passed ? gradeFor(total, rules) : lowest).grade;
    result = passed ? 'Pass' : 'Fail';
  }
  return { ...v, internal, total, grade, result, passed, complete, internalComplete };
};

export const summarize = (rows) => {
  const done = rows.filter((r) => r.complete);
  const totals = done.map((r) => r.total);
  const grades = {};
  for (const r of done) grades[r.grade] = (grades[r.grade] || 0) + 1;
  return {
    students: rows.length,
    complete: done.length,
    pending: rows.length - done.length,
    passed: done.filter((r) => r.passed).length,
    failed: done.filter((r) => !r.passed).length,
    average: totals.length ? round2(totals.reduce((s, t) => s + t, 0) / totals.length) : null,
    highest: totals.length ? Math.max(...totals) : null,
    lowest: totals.length ? Math.min(...totals) : null,
    grades,
  };
};

// The complete sheet of one subject: header details, every enrolled student with the six marks, calculated totals and grades.
// Used by the screen, the PDF, the Excel file and the snapshot that is sent to the office.
export const buildSheet = async (courseId) => {
  const course = await Course.findById(courseId).populate('teacher', 'name').lean();
  if (!course) throw ApiError.notFound('Course not found');

  const [semester, department, settings, studentIds, saved, last] = await Promise.all([
    Semester.findById(course.semester).select('name number academicYear').lean(),
    Department.findById(course.department).select('name code').lean(),
    UniversitySettings.getSettings(),
    enrolledStudentIds(course._id),
    MarksProforma.find({ course: course._id }).lean(),
    ProformaSubmission.findOne({ course: course._id }).sort({ createdAt: -1 }).select('version createdAt recipients receivedBy').lean(),
  ]);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: studentIds } }).select('name').lean(),
    StudentProfile.find({ user: { $in: studentIds } }).select('user rollNumber').lean(),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  const byStudent = new Map(saved.map((m) => [String(m.student), m]));

  const rows = users
    .map((u) => {
      const m = byStudent.get(String(u._id)) || {};
      return {
        student: u._id,
        name: u.name,
        rollNumber: roll.get(String(u._id)) || '',
        status: m.status || MARKS_STATUS.DRAFT,
        ...computeRow(m, settings),
      };
    })
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));

  return {
    university: { name: settings.universityName, campus: settings.campusName, address: settings.address || '', hasLogo: !!(settings.logoData?.length || settings.logoUrl) },
    course: { _id: course._id, code: course.code, title: course.title, creditHours: course.creditHours, section: course.section },
    semester: semester ? { _id: semester._id, name: semester.name, number: semester.number, academicYear: semester.academicYear } : null,
    department: department ? { _id: department._id, name: department.name, code: department.code } : null,
    teacher: course.teacher ? { _id: course.teacher._id, name: course.teacher.name } : null,
    components: COMPONENTS,
    passingPercentage: settings.passingPercentage,
    gradingRules: plainRules(settings),
    locked: rows.length > 0 && rows.every((r) => r.status === MARKS_STATUS.SUBMITTED),
    lastSubmission: last ? { version: last.version, at: last.createdAt, recipients: last.recipients, receivedBy: last.receivedBy || [] } : null,
    rows,
    summary: summarize(rows),
    generatedAt: new Date().toISOString(),
  };
};

// ===== Automatic suggestions from the records the system already keeps =====
// They are only SUGGESTIONS: the teacher sees them in the table, can change every number and decides what is saved.
//   attendance   : percentage of class sessions attended  x 5   (approved leave counts as present when the university rule says so)
//   quiz         : average of the best score in every closed quiz  x 5 (a quiz the student did not attempt counts as 0)
//   assignment   : average of the graded assignments whose deadline has passed  x 5 (no submission counts as 0)
//   presentation : the same for work of type "presentation"
//   midterm      : the marks of the published midterm examination of this course, scaled to 20
//   finalTerm    : the marks of the published final examination of this course, scaled to 60
export const suggestMarks = async (course, studentIds, settings) => {
  const ids = studentIds.map(String);
  const [sessions, quizzes, attempts, assignments, submissions, exams] = await Promise.all([
    Attendance.find({ course: course._id }).select('records').lean(),
    Quiz.find({ course: course._id, status: QUIZ_STATUS.CLOSED }).select('maxMarks').lean(),
    QuizAttempt.find({ course: course._id, status: { $in: [ATTEMPT_STATUS.SUBMITTED, ATTEMPT_STATUS.AUTO_SUBMITTED] }, score: { $ne: null } }).select('quiz student score maxScore').lean(),
    Assignment.find({ course: course._id, deadline: { $lte: new Date() } }).select('type maxMarks').lean(),
    Submission.find({ course: course._id }).select('assignment student marks').lean(),
    Examination.find({ semester: course.semester._id || course.semester, status: EXAM_STATUS.PUBLISHED, type: { $in: ['midterm', 'final'] }, 'papers.course': course._id }).sort({ startDate: -1 }).lean(),
  ]);

  // attendance
  const leaveCounts = settings.attendanceRules?.allowApprovedLeaveAsPresent !== false;
  const att = new Map();
  for (const s of sessions) {
    for (const r of s.records) {
      const key = String(r.student);
      const a = att.get(key) || { present: 0, total: 0 };
      a.total += 1;
      if (r.status === ATTENDANCE_STATUS.PRESENT || (leaveCounts && r.status === ATTENDANCE_STATUS.LEAVE)) a.present += 1;
      att.set(key, a);
    }
  }

  // quizzes: best attempt per quiz
  const best = new Map();
  for (const a of attempts) {
    const ratio = a.maxScore ? a.score / a.maxScore : 0;
    const key = `${a.quiz}:${a.student}`;
    if (!best.has(key) || ratio > best.get(key)) best.set(key, ratio);
  }

  // assignments and presentations
  const subBy = new Map(submissions.map((s) => [`${s.assignment}:${s.student}`, s]));
  const ofType = (type) => assignments.filter((a) => (a.type || 'assignment') === type);
  const workScore = (list, studentId) => {
    const ratios = [];
    for (const a of list) {
      const s = subBy.get(`${a._id}:${studentId}`);
      if (!s) ratios.push(0);
      else if (s.marks !== null && s.marks !== undefined) ratios.push(a.maxMarks ? Math.min(1, s.marks / a.maxMarks) : 0);
      // a submission that is not graded yet is left out, so it cannot lower the suggestion
    }
    return ratios.length ? ratios.reduce((x, y) => x + y, 0) / ratios.length : null;
  };

  // exams
  const pick = (type) => exams.find((e) => e.type === type);
  const midExam = pick('midterm');
  const finExam = pick('final');
  const examIds = [midExam, finExam].filter(Boolean).map((e) => e._id);
  const examMarks = examIds.length ? await ExaminationMarks.find({ examination: { $in: examIds }, course: course._id }).select('examination student marks absent').lean() : [];
  const marksBy = new Map(examMarks.map((m) => [`${m.examination}:${m.student}`, m]));
  const fromExam = (exam, studentId, max) => {
    if (!exam) return null;
    const paper = exam.papers.find((p) => String(p.course) === String(course._id));
    const m = marksBy.get(`${exam._id}:${studentId}`);
    if (!paper || !m) return null;
    if (m.absent) return 0;
    if (m.marks === null || m.marks === undefined) return null;
    return clamp((m.marks / paper.maxMarks) * max, max);
  };

  const assignmentList = ofType('assignment');
  const presentationList = ofType('presentation');
  const rows = ids.map((id) => {
    const a = att.get(id);
    const quizAvg = quizzes.length ? quizzes.reduce((s, q) => s + (best.get(`${q._id}:${id}`) || 0), 0) / quizzes.length : null;
    const asg = workScore(assignmentList, id);
    const pres = workScore(presentationList, id);
    return {
      student: id,
      attendance: a && a.total ? clamp((a.present / a.total) * maxOf('attendance'), maxOf('attendance')) : null,
      quiz: quizAvg === null ? null : clamp(quizAvg * maxOf('quiz'), maxOf('quiz')),
      assignment: asg === null ? null : clamp(asg * maxOf('assignment'), maxOf('assignment')),
      presentation: pres === null ? null : clamp(pres * maxOf('presentation'), maxOf('presentation')),
      midterm: fromExam(midExam, id, maxOf('midterm')),
      finalTerm: fromExam(finExam, id, maxOf('finalTerm')),
    };
  });

  return {
    basis: {
      attendanceSessions: sessions.length,
      quizzes: quizzes.length,
      assignments: assignmentList.length,
      presentations: presentationList.length,
      midtermExam: midExam?.name || null,
      finalExam: finExam?.name || null,
    },
    rows,
  };
};
