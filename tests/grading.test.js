import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeFor, computeResult } from '../src/services/gradingService.js';

const RULES = [
  { grade: 'A', minPercentage: 85, gpaPoints: 4 },
  { grade: 'B', minPercentage: 70, gpaPoints: 3 },
  { grade: 'C', minPercentage: 60, gpaPoints: 2 },
  { grade: 'D', minPercentage: 50, gpaPoints: 1 },
  { grade: 'F', minPercentage: 0, gpaPoints: 0 },
];
const SETTINGS = { gradingRules: RULES, passingPercentage: 50 };
const paper = (obtained, extra = {}) => ({ maxMarks: 100, passingMarks: 40, obtained, ...extra });

test('gradeFor picks the highest rule whose minimum is reached', () => {
  assert.equal(gradeFor(85, RULES).grade, 'A');
  assert.equal(gradeFor(84.99, RULES).grade, 'B');
  assert.equal(gradeFor(50, RULES).grade, 'D');
  assert.equal(gradeFor(49.99, RULES).grade, 'F');
  assert.equal(gradeFor(0, RULES).grade, 'F');
});

test('gradeFor does not depend on the order of the rules', () => {
  const shuffled = [RULES[3], RULES[0], RULES[4], RULES[2], RULES[1]];
  assert.equal(gradeFor(72, shuffled).grade, 'B');
});

test('computeResult: a student above every threshold passes with the right totals', () => {
  const r = computeResult([paper(90), paper(80)], SETTINGS);
  assert.equal(r.totalMax, 200);
  assert.equal(r.totalObtained, 170);
  assert.equal(r.percentage, 85);
  assert.equal(r.outcome, 'pass');
  assert.equal(r.grade, 'A');
  assert.equal(r.gpaPoints, 4);
});

test('computeResult: failing one paper fails the student even if the overall percentage is fine', () => {
  const r = computeResult([paper(30), paper(95)], SETTINGS);
  assert.equal(r.percentage, 62.5);
  assert.equal(r.outcome, 'fail');
  assert.equal(r.grade, 'F'); // a failed student gets the lowest grade
  assert.equal(r.gpaPoints, 0);
  assert.equal(r.subjects[0].passed, false);
  assert.equal(r.subjects[1].passed, true);
});

test('computeResult: overall percentage below the university minimum fails', () => {
  const r = computeResult([paper(45, { passingMarks: 40 }), paper(45, { passingMarks: 40 })], { ...SETTINGS, passingPercentage: 60 });
  assert.equal(r.percentage, 45);
  assert.equal(r.outcome, 'fail');
});

test('computeResult: an absent student scores 0 and fails that paper', () => {
  const r = computeResult([paper(90), paper(99, { absent: true })], SETTINGS);
  assert.equal(r.subjects[1].obtained, 0);
  assert.equal(r.subjects[1].passed, false);
  assert.equal(r.totalObtained, 90);
  assert.equal(r.outcome, 'fail');
});

test('computeResult: no papers gives 0% and does not divide by zero', () => {
  const r = computeResult([], SETTINGS);
  assert.equal(r.percentage, 0);
  assert.equal(r.totalMax, 0);
});

test('computeResult uses the configured grading rules, not hard-coded ones', () => {
  const strict = { gradingRules: [{ grade: 'Pass+', minPercentage: 90, gpaPoints: 4 }, { grade: 'Pass', minPercentage: 40, gpaPoints: 2 }, { grade: 'Fail', minPercentage: 0, gpaPoints: 0 }], passingPercentage: 40 };
  const r = computeResult([paper(60)], strict);
  assert.equal(r.grade, 'Pass');
  assert.equal(r.gpaPoints, 2);
});
