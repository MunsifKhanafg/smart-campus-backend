import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeQuiz, quizPhase, quizWindow, attemptDeadline } from '../src/services/quizService.js';
import { assessRisk } from '../src/services/performanceService.js';

const MIN = 60 * 1000;

// ---------- quiz marking ----------
const QUESTIONS = [
  { _id: 'q1', marks: 2, correctIndex: 1 },
  { _id: 'q2', marks: 3, correctIndex: 0 },
  { _id: 'q3', marks: 5, correctIndex: 2 },
];

test('gradeQuiz adds the marks of the correct answers only', () => {
  const answers = [{ question: 'q1', selected: 1 }, { question: 'q2', selected: 2 }, { question: 'q3', selected: 2 }];
  assert.deepEqual(gradeQuiz(QUESTIONS, answers), { score: 7, maxScore: 10 });
});

test('gradeQuiz gives 0 for unanswered questions and handles no answers at all', () => {
  assert.deepEqual(gradeQuiz(QUESTIONS, [{ question: 'q2', selected: 0 }]), { score: 3, maxScore: 10 });
  assert.deepEqual(gradeQuiz(QUESTIONS, []), { score: 0, maxScore: 10 });
  assert.deepEqual(gradeQuiz(QUESTIONS), { score: 0, maxScore: 10 });
});

test('gradeQuiz ignores answers for questions that do not exist', () => {
  assert.deepEqual(gradeQuiz(QUESTIONS, [{ question: 'zzz', selected: 0 }]), { score: 0, maxScore: 10 });
});

// ---------- quiz visibility and timing ----------
test('a scheduled quiz is upcoming, then open, then closed', () => {
  const quiz = { type: 'scheduled', status: 'scheduled', startTime: new Date(1000), endTime: new Date(5000) };
  assert.equal(quizPhase(quiz, new Date(500)), 'upcoming');
  assert.equal(quizPhase(quiz, new Date(2000)), 'open');
  assert.equal(quizPhase(quiz, new Date(6000)), 'closed');
});

test('a draft scheduled quiz is not shown as open even inside its window', () => {
  const quiz = { type: 'scheduled', status: 'draft', startTime: new Date(1000), endTime: new Date(5000) };
  assert.equal(quizPhase(quiz, new Date(2000)), 'draft');
});

test('a surprise quiz stays hidden until the teacher starts it, then closes when its time runs out', () => {
  assert.equal(quizPhase({ type: 'surprise', status: 'draft' }), 'hidden');

  const live = { type: 'surprise', status: 'live', startedAt: new Date(0), durationMinutes: 10 };
  assert.equal(quizPhase(live, new Date(1000)), 'open');
  assert.equal(quizPhase(live, new Date(10 * MIN + 1)), 'closed');
  assert.equal(quizWindow(live).end.getTime(), 10 * MIN);
});

test('a closed quiz is always closed, and a surprise quiz without a start time has no window', () => {
  assert.equal(quizPhase({ type: 'scheduled', status: 'closed', startTime: new Date(0), endTime: new Date(9e12) }), 'closed');
  assert.equal(quizWindow({ type: 'surprise', status: 'draft' }), null);
});

test("a student's personal deadline is the duration, but never later than the end of the quiz window", () => {
  const quiz = { type: 'scheduled', startTime: new Date(0), endTime: new Date(5 * MIN), durationMinutes: 30 };
  assert.equal(attemptDeadline(quiz, new Date(4 * MIN)).getTime(), 5 * MIN); // window ends first
  const roomy = { ...quiz, endTime: new Date(120 * MIN) };
  assert.equal(attemptDeadline(roomy, new Date(4 * MIN)).getTime(), 34 * MIN); // duration ends first
});

// ---------- early-warning rules (advice only) ----------
const LIMITS = { minAttendance: 75, passing: 50 };
const HEALTHY = { attendance: 90, assignmentAvg: 80, missingAssignments: 0, quizAvg: 70, examPercent: 75 };

test('a student with healthy numbers is low concern', () => {
  assert.deepEqual(assessRisk(HEALTHY, LIMITS), { level: 'low', flags: [] });
});

test('missing data (null) never creates a warning by itself', () => {
  const nothingYet = { attendance: null, assignmentAvg: null, missingAssignments: 0, quizAvg: null, examPercent: null };
  assert.equal(assessRisk(nothingYet, LIMITS).level, 'low');
});

test('one warning sign is medium concern', () => {
  const r = assessRisk({ ...HEALTHY, attendance: 60 }, LIMITS);
  assert.equal(r.level, 'medium');
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].code, 'attendance');
});

test('two missed assignments raise a warning', () => {
  const r = assessRisk({ ...HEALTHY, missingAssignments: 2 }, LIMITS);
  assert.equal(r.level, 'medium');
  assert.equal(r.flags[0].code, 'missing');
});

test('failing the last exam is high concern on its own', () => {
  const r = assessRisk({ ...HEALTHY, examPercent: 40 }, LIMITS);
  assert.equal(r.level, 'high');
  assert.ok(r.flags.some((f) => f.code === 'exam'));
});

test('three warning signs together are high concern', () => {
  const r = assessRisk({ ...HEALTHY, attendance: 60, assignmentAvg: 40, quizAvg: 30 }, LIMITS);
  assert.equal(r.level, 'high');
  assert.equal(r.flags.length, 3);
});
