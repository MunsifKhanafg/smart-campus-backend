import Quiz from '../models/Quiz.js';
import QuizAttempt from '../models/QuizAttempt.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { round2 } from '../utils/oid.js';
import { getCourseFor, enrolledStudentIds } from '../services/accessService.js';
import { rearrangeForAssessment } from '../services/teachingCalendarService.js';
import {
  quizPhase,
  quizWindow,
  attemptDeadline,
  finalizeAttempt,
  finalizeExpiredAttempts,
  syncQuizStatus,
} from '../services/quizService.js';
import { ROLES, QUIZ_STATUS, ATTEMPT_STATUS } from '../config/constants.js';

const loadQuiz = async (id) => {
  const quiz = await Quiz.findById(id);
  if (!quiz) throw ApiError.notFound('Quiz not found');
  return quiz;
};

// Teacher's full view, including the correct answers.
const staffShape = (quiz) => ({ ...quiz.toObject(), phase: quizPhase(quiz), window: quizWindow(quiz) });

// Student's view of the questions: the correct answer is stripped out on the server.
const questionsForStudent = (quiz) => quiz.questions.map((q) => ({ _id: q._id, text: q.text, options: q.options, marks: q.marks }));

// ---------- Teacher ----------
export const createQuiz = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.body.course, 'write');
  const isSurprise = req.body.type === 'surprise';
  const quiz = await Quiz.create({
    ...req.body,
    ...(isSurprise ? { startTime: undefined, endTime: undefined, maxAttempts: 1 } : {}),
    course: course._id,
    department: course.department,
    semester: course.semester._id,
    // A surprise quiz stays hidden (draft) until the teacher starts it.
    status: isSurprise ? QUIZ_STATUS.DRAFT : QUIZ_STATUS.SCHEDULED,
    createdBy: req.user._id,
  });

  if (!isSurprise) {
    await notifyUsers(await enrolledStudentIds(course._id), {
      title: `Quiz scheduled: ${quiz.title}`,
      message: `${course.code} - opens ${quiz.startTime.toLocaleString()}`,
      type: 'quiz',
      link: `/my-courses/${course._id}`,
    });
  }
  logAudit(req, 'quiz.create', 'Quiz', quiz._id, { type: quiz.type, course: course.code });
  // A scheduled quiz takes its day: topics planned on that day move to the next teaching days.
  const moved = isSurprise ? 0 : await rearrangeForAssessment(course._id, `the quiz "${quiz.title}"`);
  sendSuccess(res, { ...staffShape(quiz), topicsMoved: moved }, moved ? `Quiz created. ${moved} topic(s) were moved because that day is now a quiz day` : 'Quiz created', 201);
});

export const updateQuiz = asyncHandler(async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  const course = await getCourseFor(req.user, quiz.course, 'write');
  if (quiz.status === QUIZ_STATUS.LIVE || quiz.status === QUIZ_STATUS.CLOSED) throw ApiError.badRequest('A running or closed quiz cannot be edited');
  if (await QuizAttempt.exists({ quiz: quiz._id })) throw ApiError.conflict('Students have already attempted this quiz');
  quiz.set(req.body);
  await quiz.save();
  const moved = req.body.startTime ? await rearrangeForAssessment(course._id, `the quiz "${quiz.title}"`) : 0;
  sendSuccess(res, { ...staffShape(quiz), topicsMoved: moved }, moved ? `Quiz updated. ${moved} topic(s) were moved because of the new quiz day` : 'Quiz updated');
});

export const deleteQuiz = asyncHandler(async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  await getCourseFor(req.user, quiz.course, 'write');
  if (await QuizAttempt.exists({ quiz: quiz._id })) throw ApiError.conflict('Students have already attempted this quiz and it cannot be deleted');
  await quiz.deleteOne();
  await rearrangeForAssessment(quiz.course, `the removed quiz "${quiz.title}"`);
  sendSuccess(res, null, 'Quiz deleted');
});

// Surprise quiz: the teacher presses "start". Students are notified at that moment and not before.
export const startSurprise = asyncHandler(async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  const course = await getCourseFor(req.user, quiz.course, 'write');
  if (quiz.type !== 'surprise') throw ApiError.badRequest('Only surprise quizzes are started manually');
  if (quiz.status !== QUIZ_STATUS.DRAFT) throw ApiError.conflict('This quiz was already started');

  quiz.status = QUIZ_STATUS.LIVE;
  quiz.startedAt = new Date();
  await quiz.save();

  await notifyUsers(await enrolledStudentIds(course._id), {
    title: `Surprise quiz started: ${course.code}`,
    message: `You have ${quiz.durationMinutes} minutes. Open the course now.`,
    type: 'quiz',
    link: `/my-courses/${course._id}`,
  });
  logAudit(req, 'quiz.start_surprise', 'Quiz', quiz._id, { course: course.code });
  // Today becomes a quiz day: today's topics move to the next teaching day.
  const moved = await rearrangeForAssessment(course._id, `the surprise quiz "${quiz.title}"`);
  sendSuccess(res, { ...staffShape(quiz), topicsMoved: moved }, moved ? `Surprise quiz started. ${moved} topic(s) were moved to the next teaching days` : 'Surprise quiz started');
});

// Ends the quiz now. Every unfinished attempt is marked with the answers saved so far.
export const closeQuiz = asyncHandler(async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  await getCourseFor(req.user, quiz.course, 'write');
  if (quiz.status === QUIZ_STATUS.CLOSED) throw ApiError.conflict('This quiz is already closed');
  if (quiz.status === QUIZ_STATUS.DRAFT) throw ApiError.badRequest('This quiz has not started');

  quiz.status = QUIZ_STATUS.CLOSED;
  quiz.closedAt = new Date();
  await quiz.save();
  await QuizAttempt.updateMany(
    { quiz: quiz._id, status: ATTEMPT_STATUS.IN_PROGRESS },
    { expiresAt: new Date(Date.now() - 1000) }
  );
  await finalizeExpiredAttempts({ quiz: quiz._id });
  sendSuccess(res, staffShape(quiz), 'Quiz closed');
});

export const listQuizzes = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.query.course, 'any');
  await finalizeExpiredAttempts({ course: course._id });
  const quizzes = await Quiz.find({ course: course._id }).sort({ createdAt: -1 });
  for (const q of quizzes) await syncQuizStatus(q);

  if (req.user.role !== ROLES.STUDENT) {
    const counts = await QuizAttempt.aggregate([
      { $match: { quiz: { $in: quizzes.map((q) => q._id) } } },
      { $group: { _id: '$quiz', attempts: { $sum: 1 } } },
    ]);
    const byQuiz = new Map(counts.map((c) => [String(c._id), c.attempts]));
    return sendSuccess(res, quizzes.map((q) => ({
      _id: q._id, title: q.title, type: q.type, status: q.status, phase: quizPhase(q),
      durationMinutes: q.durationMinutes, startTime: q.startTime, endTime: q.endTime, startedAt: q.startedAt,
      maxMarks: q.maxMarks, maxAttempts: q.maxAttempts, questionCount: q.questions.length, attempts: byQuiz.get(String(q._id)) || 0,
    })));
  }

  // Student: surprise quizzes that have not started are completely invisible (not even their title).
  const mine = await QuizAttempt.find({ student: req.user._id, quiz: { $in: quizzes.map((q) => q._id) } });
  const rows = [];
  for (const q of quizzes) {
    const phase = quizPhase(q);
    const attempts = mine.filter((a) => String(a.quiz) === String(q._id));
    if (phase === 'hidden' || phase === 'draft') continue;
    if (q.type === 'surprise' && phase === 'closed' && !attempts.length) continue;
    const finished = attempts.filter((a) => a.status !== ATTEMPT_STATUS.IN_PROGRESS);
    const best = finished.length ? Math.max(...finished.map((a) => a.score ?? 0)) : null;
    rows.push({
      _id: q._id, title: q.title, type: q.type, phase, durationMinutes: q.durationMinutes, maxMarks: q.maxMarks, maxAttempts: q.maxAttempts,
      startTime: q.startTime, endTime: q.endTime, startedAt: q.startedAt, attemptsUsed: attempts.length, bestScore: best,
      inProgress: attempts.some((a) => a.status === ATTEMPT_STATUS.IN_PROGRESS && a.expiresAt > new Date()),
    });
  }
  sendSuccess(res, rows);
});

export const getQuiz = asyncHandler(async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  await getCourseFor(req.user, quiz.course, 'staff');
  sendSuccess(res, staffShape(quiz));
});

export const quizResults = asyncHandler(async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  await getCourseFor(req.user, quiz.course, 'staff');
  await finalizeExpiredAttempts({ quiz: quiz._id });

  const attempts = await QuizAttempt.find({ quiz: quiz._id, status: { $ne: ATTEMPT_STATUS.IN_PROGRESS } }).lean();
  const studentIds = await enrolledStudentIds(quiz.course);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: studentIds } }).select('name').lean(),
    StudentProfile.find({ user: { $in: studentIds } }).select('user rollNumber').lean(),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));

  const rows = users
    .map((u) => {
      const mine = attempts.filter((a) => String(a.student) === String(u._id));
      const best = mine.length ? Math.max(...mine.map((a) => a.score ?? 0)) : null;
      return { student: u._id, name: u.name, rollNumber: roll.get(String(u._id)) || '', attempts: mine.length, bestScore: best, status: mine.length ? 'attempted' : 'not attempted' };
    })
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));

  const scores = rows.filter((r) => r.bestScore !== null).map((r) => r.bestScore);
  sendSuccess(res, {
    quiz: { _id: quiz._id, title: quiz.title, maxMarks: quiz.maxMarks },
    stats: scores.length
      ? { attempted: scores.length, average: round2(scores.reduce((a, b) => a + b, 0) / scores.length), highest: Math.max(...scores), lowest: Math.min(...scores) }
      : { attempted: 0 },
    rows,
  });
});

// ---------- Student ----------
const loadOwnAttempt = async (attemptId, user) => {
  const attempt = await QuizAttempt.findById(attemptId);
  if (!attempt || String(attempt.student) !== String(user._id)) throw ApiError.notFound('Attempt not found');
  return attempt;
};

// Validates that every answer points at a real question and a real option.
const cleanAnswers = (quiz, answers) => {
  const byId = new Map(quiz.questions.map((q) => [String(q._id), q]));
  const seen = new Set();
  return answers.filter((a) => {
    const q = byId.get(String(a.question));
    if (!q || a.selected >= q.options.length || seen.has(String(a.question))) return false;
    seen.add(String(a.question));
    return true;
  });
};

export const startAttempt = asyncHandler(async (req, res) => {
  const quiz = await loadQuiz(req.params.id);
  await getCourseFor(req.user, quiz.course, 'any'); // must be enrolled
  await finalizeExpiredAttempts({ quiz: quiz._id, student: req.user._id });
  await syncQuizStatus(quiz);

  const phase = quizPhase(quiz);
  if (phase !== 'open') throw ApiError.badRequest(phase === 'upcoming' ? 'This quiz has not opened yet' : 'This quiz is not available');

  const attempts = await QuizAttempt.find({ quiz: quiz._id, student: req.user._id });
  let attempt = attempts.find((a) => a.status === ATTEMPT_STATUS.IN_PROGRESS);
  if (!attempt) {
    if (attempts.length >= quiz.maxAttempts) throw ApiError.conflict('You have used all your attempts');
    attempt = await QuizAttempt.create({
      quiz: quiz._id,
      course: quiz.course,
      student: req.user._id,
      attemptNumber: attempts.length + 1,
      expiresAt: attemptDeadline(quiz),
    });
  }
  sendSuccess(res, {
    attempt: { _id: attempt._id, startedAt: attempt.startedAt, expiresAt: attempt.expiresAt, answers: attempt.answers },
    quiz: { _id: quiz._id, title: quiz.title, durationMinutes: quiz.durationMinutes, maxMarks: quiz.maxMarks },
    questions: questionsForStudent(quiz),
    serverTime: new Date(), // lets the browser show a countdown that matches the server clock
  });
});

export const saveAnswers = asyncHandler(async (req, res) => {
  const attempt = await loadOwnAttempt(req.params.attemptId, req.user);
  if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) throw ApiError.conflict('This attempt is already finished');
  if (new Date() > attempt.expiresAt) throw ApiError.badRequest('Time is up');
  const quiz = await loadQuiz(attempt.quiz);
  attempt.answers = cleanAnswers(quiz, req.body.answers);
  await attempt.save();
  sendSuccess(res, { saved: attempt.answers.length, expiresAt: attempt.expiresAt });
});

export const submitAttempt = asyncHandler(async (req, res) => {
  const attempt = await loadOwnAttempt(req.params.attemptId, req.user);
  if (attempt.status !== ATTEMPT_STATUS.IN_PROGRESS) throw ApiError.conflict('This attempt is already submitted');
  const quiz = await loadQuiz(attempt.quiz);

  // 5 seconds of grace for network delay. After that only the answers saved earlier count.
  const onTime = Date.now() <= attempt.expiresAt.getTime() + 5000;
  if (onTime) attempt.answers = cleanAnswers(quiz, req.body.answers);
  await finalizeAttempt(attempt, quiz, onTime ? ATTEMPT_STATUS.SUBMITTED : ATTEMPT_STATUS.AUTO_SUBMITTED);
  sendSuccess(
    res,
    { status: attempt.status, score: attempt.score, maxScore: attempt.maxScore },
    onTime ? 'Quiz submitted' : 'Time had run out. Your saved answers were submitted'
  );
});

export const myQuizResults = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.query.course, 'any');
  await finalizeExpiredAttempts({ course: course._id, student: req.user._id });
  const attempts = await QuizAttempt.find({ course: course._id, student: req.user._id, status: { $ne: ATTEMPT_STATUS.IN_PROGRESS } })
    .populate('quiz', 'title type')
    .sort({ submittedAt: -1 })
    .lean();
  sendSuccess(res, attempts.map((a) => ({
    _id: a._id, quiz: a.quiz?.title, type: a.quiz?.type, attemptNumber: a.attemptNumber, score: a.score, maxScore: a.maxScore,
    status: a.status, submittedAt: a.submittedAt,
  })));
});
