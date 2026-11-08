import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurriculumRules, normalizeDraft, explodeLines } from '../src/services/curriculumService.js';

// A scheme of studies where semesters 7 and 8 have 5 subjects each (two of them are elective SLOTS), followed by pages
// that list the ELECTIVE OPTIONS "for the 7th/8th semester". The options are kept, flagged as electives, so the HOD can
// choose which ones to offer. They must never count as subjects of the scheme.
const DOC = `
Proposed Revised Scheme of Studies for BS (CS)
Semester VII
CS6701 Technical and Scientific Writing 3(3+0)
CS6702 FYP - I 3(0+3)
BA565 Entrepreneurship 3(3+0)
CS67XX Specialization Elective - I 3(3+0)
CS67XX Specialization Elective - II 3(3+0)
Total Credit Hours 15
Semester VIII
CS6801 Natural Language Processing 3(3+0)
CS6802 Professional Practices 3(3+0)
CS6803 FYP - II 3(0+3)
CS68XX Specialization Elective - III 3(3+0)
CS68XX Specialization Elective - IV 3(3+0)
Total Credit Hours 15

Seventh (7th) Semester Specializations Elective Courses
Course Code Course Title Credit Hours
CS6711 Machine Learning 3(3+0)
Course Contents: Regression, classification
CS6712 Deep Learning 3(3+0)
CS6713 Data Mining 3(3+0)
Semester VII
CS6717 Computer Vision 3(3+0)
8th Semester Specializations Elective Courses
CS6811 Reinforcement Learning 3(3+0)
CS6812 Speech Processing 3(3+0)
`;

const semesters = () => Object.fromEntries(normalizeDraft(parseCurriculumRules(DOC)).programs[0].semesters.map((s) => [s.number, s.subjects]));

test('semesters 7 and 8 keep exactly their 5 scheme subjects, none of them marked as elective options', () => {
  const sems = semesters();
  const core7 = sems[7].filter((x) => !x.elective);
  const core8 = sems[8].filter((x) => !x.elective);
  assert.deepEqual(core7.map((x) => x.code), ['CS-6701', 'CS-6702', 'BA-565', 'CS67XX-I', 'CS67XX-II']);
  assert.equal(core8.length, 5);
});

test('the elective options are kept and flagged, with their course contents', () => {
  const sems = semesters();
  const options7 = sems[7].filter((x) => x.elective).map((x) => x.code);
  assert.deepEqual(options7, ['CS-6711', 'CS-6712', 'CS-6713']);
  assert.equal(sems[7].find((x) => x.code === 'CS-6711').outline, 'Regression, classification');
  assert.deepEqual(sems[8].filter((x) => x.elective).map((x) => x.code), ['CS-6811', 'CS-6812']);
});

test('a course listed again under a plain "Semester VII" heading is not added (it is not an elective option)', () => {
  assert.ok(!semesters()[7].some((x) => x.code === 'CS-6717'));
});

test('the credit total check ignores the elective options', () => {
  const { warnings } = parseCurriculumRules(DOC);
  assert.ok(!warnings.some((w) => /credit hours but the document says/.test(w)));
});

test('normalizeDraft keeps the elective flag and drops it when false', () => {
  const { programs } = normalizeDraft({ programs: [{ name: 'BS CS', semesters: [{ number: 7, subjects: [
    { code: 'cs 6711', title: 'ML', creditHours: 3, elective: true },
    { code: 'cs 6701', title: 'Writing', creditHours: 3 },
  ] }] }] });
  const [a, b] = programs[0].semesters[0].subjects;
  assert.equal(a.elective, true);
  assert.equal('elective' in b, false);
});

test('a whole table that arrives on ONE line is split into lines first', () => {
  const flat = 'Semester VII CS6701 Technical and Scientific Writing 3(3+0) CS6702 FYP - I 3(0+3) BA565 Entrepreneurship 3(3+0) CS67XX Specialization Elective - I 3(3+0) CS67XX Specialization Elective - II 3(3+0) Total Credit Hours 15 Semester VIII CS6801 Natural Language Processing 3(3+0) CS6802 Professional Practices 3(3+0) CS6803 FYP - II 3(0+3) CS68XX Specialization Elective - III 3(3+0) CS68XX Specialization Elective - IV 3(3+0) Total Credit Hours 15';
  assert.ok(explodeLines(flat).split('\n').length >= 10);
  const sems = normalizeDraft(parseCurriculumRules(flat)).programs[0].semesters;
  assert.deepEqual(sems.map((s) => [s.number, s.subjects.length]), [[7, 5], [8, 5]]);
});

test('a title that wraps onto the next line is joined, and a code split over two lines is read as one code', () => {
  const text = 'BS (CS)\nSemester III\nMATH-\n432\nComputation in MATLAB 3(2+1)\nCS4301 Data Structures and\nAlgorithms 4(3+1)\nTotal Credit Hours 7';
  const subs = normalizeDraft(parseCurriculumRules(text)).programs[0].semesters[0].subjects;
  assert.deepEqual(subs.map((s) => [s.code, s.title, s.creditHours]), [['MATH-432', 'Computation in MATLAB', 3], ['CS-4301', 'Data Structures and Algorithms', 4]]);
});
