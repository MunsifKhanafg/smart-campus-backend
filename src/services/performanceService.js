import Assignment from '../models/Assignment.js';
import Submission from '../models/Submission.js';
import Quiz from '../models/Quiz.js';
import QuizAttempt from '../models/QuizAttempt.js';
import Result from '../models/Result.js';
import CourseTopic from '../models/CourseTopic.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { attendanceCounts, attendancePercent, emptyCounts } from './attendanceService.js';
import { round2 } from '../utils/oid.js';
import { ATTEMPT_STATUS, RESULT_STATUS } from '../config/constants.js';

const avg = (arr) => (arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

// ===== Early-warning rules (pure, unit tested). They only produce ADVICE; they never change a mark or a decision. =====
export const assessRisk = (m, t) => {
  const flags = [];
  if (m.attendance !== null && m.attendance < t.minAttendance) flags.push({ code: 'attendance', message: `Attendance is ${m.attendance}%, below the required ${t.minAttendance}%` });
  if (m.assignmentAvg !== null && m.assignmentAvg < 50) flags.push({ code: 'assignments', message: `Assignment average is ${m.assignmentAvg}%` });
  if (m.missingAssignments >= 2) flags.push({ code: 'missing', message: `${m.missingAssignments} assignments were not submitted` });
  if (m.quizAvg !== null && m.quizAvg < 50) flags.push({ code: 'quizzes', message: `Quiz average is ${m.quizAvg}%` });
  const examWeak = m.examPercent !== null && m.examPercent < t.passing;
  if (examWeak) flags.push({ code: 'exam', message: `Last exam score ${m.examPercent}% is below the passing mark` });
  const level = examWeak || flags.length >= 3 ? 'high' : flags.length >= 1 ? 'medium' : 'low';
  return { level, flags };
};

// Gathers every indicator for several students of ONE course with a handful of queries.
export const computeCourseMetrics = async (course, studentIds) => {
  const settings = await UniversitySettings.getSettings();
  const now = new Date();
  const [counts, assignments, subs, quizzes, attempts, results] = await Promise.all([
    attendanceCounts({ courseIds: [course._id], studentIds }),
    Assignment.find({ course: course._id }).select('maxMarks deadline').lean(),
    Submission.find({ course: course._id, student: { $in: studentIds } }).select('assignment student marks').lean(),
    Quiz.find({ course: course._id }).select('maxMarks').lean(),
    QuizAttempt.find({ course: course._id, student: { $in: studentIds }, status: { $ne: ATTEMPT_STATUS.IN_PROGRESS } }).select('quiz student score maxScore').lean(),
    Result.find({ student: { $in: studentIds }, status: RESULT_STATUS.PUBLISHED, 'subjects.course': course._id }).sort({ publishedAt: -1 }).lean(),
  ]);
  const aMax = new Map(assignments.map((a) => [String(a._id), a]));
  const thresholds = { minAttendance: settings.admissionRules.minAttendancePercentage, passing: settings.passingPercentage };

  const out = new Map();
  for (const id of studentIds) {
    const sid = String(id);
    const mySubs = subs.filter((s) => String(s.student) === sid);
    const graded = mySubs.filter((s) => s.marks !== null && aMax.get(String(s.assignment))).map((s) => (s.marks / aMax.get(String(s.assignment)).maxMarks) * 100);
    const submitted = new Set(mySubs.map((s) => String(s.assignment)));
    const missing = assignments.filter((a) => a.deadline < now && !submitted.has(String(a._id))).length;

    const best = new Map();
    for (const a of attempts.filter((x) => String(x.student) === sid && x.maxScore)) {
      const pct = (a.score / a.maxScore) * 100;
      best.set(String(a.quiz), Math.max(best.get(String(a.quiz)) ?? 0, pct));
    }
    const mine = results.find((r) => String(r.student) === sid);
    const subject = mine?.subjects.find((s) => String(s.course) === String(course._id));

    const metrics = {
      attendance: attendancePercent(counts.get(`${course._id}:${sid}`) || emptyCounts(), settings.attendanceRules.allowApprovedLeaveAsPresent),
      assignmentAvg: avg(graded),
      missingAssignments: missing,
      quizAvg: avg([...best.values()]),
      examPercent: subject ? (subject.absent ? 0 : round2((subject.obtained / subject.maxMarks) * 100)) : null,
    };
    out.set(sid, { metrics, ...assessRisk(metrics, thresholds) });
  }
  return out;
};

// Released topics are a sensible "what to revise" list for a student with warning signs.
export const revisionTopics = async (courseId, limit = 5) =>
  (await CourseTopic.find({ course: courseId, scheduledDate: { $lte: new Date() } }).sort({ scheduledDate: -1 }).limit(limit).select('title').lean()).map((t) => t.title);
