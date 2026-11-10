import test from 'node:test';
import assert from 'node:assert/strict';
import { fitsSubject, canTeachIn, describeLoad, weeklyClassesOf, tagFits } from '../src/services/teacherEligibility.js';

const english = { code: 'CS-3104', title: 'Functional English' };
const calculus = { code: 'CS-3102', title: 'Calculus and Analytical Geometry' };
const islamiat = { code: 'HU-101', title: 'Islamic Studies' };
const pak = { code: 'HU-102', title: 'Pakistan Studies' };
const ds = { code: 'CS-4301', title: 'Data Structures and Algorithms' };
const dm = { code: 'CS-6713', title: 'Data Mining' };

test('an English teacher fits English subjects only', () => {
  const t = { subjects: ['English'] };
  assert.equal(fitsSubject(t, english).fit, true);
  assert.equal(fitsSubject(t, calculus).fit, false);
  assert.equal(fitsSubject(t, ds).fit, false);
});

test('a Mathematics teacher fits calculus, algebra and statistics (the same family)', () => {
  const t = { subjects: ['Mathematics'] };
  assert.equal(fitsSubject(t, calculus).fit, true);
  assert.equal(fitsSubject(t, { code: 'MATH-201', title: 'Linear Algebra' }).fit, true);
  assert.equal(fitsSubject(t, { code: 'MATH-301', title: 'Probability and Statistics' }).fit, true);
  assert.equal(fitsSubject(t, english).fit, false);
});

test('Islamiat and Pakistan Studies teachers fit their own subjects and nothing else', () => {
  const isl = { subjects: ['Islamiat'] };
  const pk = { subjects: ['Pak Studies'] };
  assert.equal(fitsSubject(isl, islamiat).fit, true);
  assert.equal(fitsSubject(isl, pak).fit, false);
  assert.equal(fitsSubject(pk, pak).fit, true);
  assert.equal(fitsSubject(pk, islamiat).fit, false);
});

test('a specific tag fits its own subject but not a different one that shares a word', () => {
  const t = { subjects: ['Data Structures'] };
  assert.equal(fitsSubject(t, ds).fit, true);
  assert.equal(fitsSubject(t, dm).fit, false); // "Data Mining" only shares the word "data"
});

test('a course code or a code prefix in the list fits', () => {
  assert.equal(tagFits('CS-4301', ds), true);
  assert.equal(tagFits('cs 4301', ds), true);
  assert.equal(tagFits('CS', ds), true);
  assert.equal(tagFits('MATH', { code: 'MATH-432', title: 'Computation in MATLAB' }), true);
  assert.equal(tagFits('MA', { code: 'MATH-432', title: 'x' }), false); // "MA" is a prefix of MATH but not followed by a digit
});

test('a teacher with no subjects listed fits nothing, unless they already teach that subject', () => {
  assert.equal(fitsSubject({ subjects: [] }, english).fit, false);
  const r = fitsSubject({ subjects: [] }, english, [{ code: 'CS-3104', title: 'Functional English' }]);
  assert.deepEqual(r, { fit: true, why: 'history' });
  assert.equal(fitsSubject({}, english).fit, false);
});

test('a teacher can teach in their own department and in the extra departments they were given', () => {
  const t = { department: 'd1', extraDepartments: ['d2', { _id: 'd3' }] };
  assert.equal(canTeachIn(t, 'd1'), true);
  assert.equal(canTeachIn(t, 'd2'), true);
  assert.equal(canTeachIn(t, 'd3'), true);
  assert.equal(canTeachIn(t, 'd4'), false);
  assert.equal(canTeachIn({ department: { _id: 'd1' } }, 'd1'), true);
  assert.equal(canTeachIn(null, 'd1'), false);
});

test('weekly classes follow the credit hours unless the HOD set a number', () => {
  assert.equal(weeklyClassesOf({ creditHours: 3 }), 3);
  assert.equal(weeklyClassesOf({ creditHours: 3, weeklyClasses: 5 }), 5);
  assert.equal(weeklyClassesOf({ creditHours: 3, weeklyClasses: null }), 3);
});

test('there is no built-in limit: more than 8 classes a week is normal, and a limit only exists when the administrator sets one', () => {
  const courses = Array.from({ length: 5 }, () => ({ creditHours: 3 })); // 15 classes a week
  const free = describeLoad(courses, null);
  assert.equal(free.weeklyClasses, 15);
  assert.equal(free.level, 'none');
  assert.equal(free.max, null);

  assert.equal(describeLoad(courses, 18).level, 'high'); // 15 of 18
  assert.equal(describeLoad(courses, 20).level, 'mid');  // 15 of 20
  assert.equal(describeLoad(courses, 40).level, 'low');  // 15 of 40
  assert.equal(describeLoad(courses, 12).level, 'over'); // 15 of 12
});
