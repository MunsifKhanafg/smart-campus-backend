import Quiz from '../models/Quiz.js';
import QuizAttempt from '../models/QuizAttempt.js';
import { ATTEMPT_STATUS, QUIZ_STATUS } from '../config/constants.js';

const MINUTE = 60 * 1000;

// ---------- Pure functions (unit tested, no database) ----------

// Marks the answers. Unanswered questions score 0. The correct answers never leave the server.
export const gradeQuiz = (questions, answers = []) => {
  const chosen = new Map(answers.map((a) => [String(a.question), a.selected]));
  let score = 0;
  let maxScore = 0;
  for (const q of questions) {
    maxScore += q.marks;
    if (chosen.get(String(q._id)) === q.correctIndex) score += q.marks;
  }
  return { score, maxScore };
};

// The time window in which students may work on the quiz, or null if it has not been opened yet.
export const quizWindow = (quiz) => {
  if (quiz.type === 'scheduled') return { start: quiz.startTime, end: quiz.endTime };
  if (!quiz.startedAt) return null;
  return { start: quiz.startedAt, end: new Date(quiz.startedAt.getTime() + quiz.durationMinutes * MINUTE) };
};

// 'hidden' (surprise quiz not started) | 'draft' | 'upcoming' | 'open' | 'closed'
export const quizPhase = (quiz, now = new Date()) => {
  if (quiz.status === QUIZ_STATUS.CLOSED) return 'closed';
  if (quiz.type === 'surprise') {
    if (quiz.status !== QUIZ_STATUS.LIVE) return 'hidden';
    const w = quizWindow(quiz);
    return now <= w.end ? 'open' : 'closed';
  }
  if (quiz.status === QUIZ_STATUS.DRAFT) return 'draft';
  if (now < quiz.startTime) return 'upcoming';
  return now <= quiz.endTime ? 'open' : 'closed';
};

// A student's personal deadline: the quiz duration, but never later than the end of the window.
export const attemptDeadline = (quiz, now = new Date()) => {
  const byDuration = new Date(now.getTime() + quiz.durationMinutes * MINUTE);
  const w = quizWindow(quiz);
  return w && w.end < byDuration ? w.end : byDuration;
};

// ---------- Database helpers ----------

export const finalizeAttempt = async (attempt, quiz, status) => {
  const { score, maxScore } = gradeQuiz(quiz.questions, attempt.answers);
  attempt.score = score;
  attempt.maxScore = maxScore;
  attempt.status = status;
  attempt.submittedAt = status === ATTEMPT_STATUS.AUTO_SUBMITTED ? attempt.expiresAt : new Date();
  await attempt.save();
  return attempt;
};

// Quizzes close themselves: any unfinished attempt whose time ran out is marked with the answers saved so far.
export const finalizeExpiredAttempts = async (filter = {}) => {
  const expired = await QuizAttempt.find({
    ...filter,
    status: ATTEMPT_STATUS.IN_PROGRESS,
    expiresAt: { $lt: new Date() },
  });
  if (!expired.length) return 0;
  const quizzes = new Map();
  for (const attempt of expired) {
    const key = String(attempt.quiz);
    if (!quizzes.has(key)) quizzes.set(key, await Quiz.findById(attempt.quiz));
    const quiz = quizzes.get(key);
    if (quiz) await finalizeAttempt(attempt, quiz, ATTEMPT_STATUS.AUTO_SUBMITTED);
  }
  return expired.length;
};

// A surprise quiz whose window has passed becomes "closed" in the database too.
export const syncQuizStatus = async (quiz) => {
  if (quiz.type === 'surprise' && quiz.status === QUIZ_STATUS.LIVE && quizPhase(quiz) === 'closed') {
    quiz.status = QUIZ_STATUS.CLOSED;
    quiz.closedAt = quizWindow(quiz).end;
    await quiz.save();
  }
  return quiz;
};

// Background job (started in server.js): closes finished quizzes and finalises expired attempts even if nobody opens the page.
export const sweepQuizzes = async () => {
  await finalizeExpiredAttempts();
  const live = await Quiz.find({ type: 'surprise', status: QUIZ_STATUS.LIVE });
  for (const q of live) await syncQuizStatus(q);
};
