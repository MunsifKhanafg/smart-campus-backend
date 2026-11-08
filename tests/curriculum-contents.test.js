import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurriculumRules, normalizeDraft } from '../src/services/curriculumService.js';
import { buildAssignmentMessage } from '../src/services/assignmentNotice.js';

// ---------- reading "Course Contents:" from a curriculum document ----------
const DOCUMENT = `BS Computer Science
Semester 1
CS-101 Introduction to Computing 3(2+1)
Course Contents: Number systems, algorithms
and basic programming
CS-102 Programming Fundamentals 4
Semester 2
CS-201 Data Structures 3`;

test('the rule reader attaches the course contents to the subject above it, including continuation lines', () => {
  const { programs } = parseCurriculumRules(DOCUMENT);
  assert.equal(programs[0].name, 'BS Computer Science');
  assert.deepEqual(programs[0].semesters[0].subjects[0], {
    code: 'CS-101',
    title: 'Introduction to Computing',
    creditHours: 3,
    outline: 'Number systems, algorithms and basic programming',
  });
});

test('subjects without contents keep exactly their old shape (no empty outline key)', () => {
  const { programs } = parseCurriculumRules(DOCUMENT);
  assert.deepEqual(programs[0].semesters[0].subjects[1], { code: 'CS-102', title: 'Programming Fundamentals', creditHours: 4 });
  assert.deepEqual(programs[0].semesters[1].subjects[0], { code: 'CS-201', title: 'Data Structures', creditHours: 3 });
});

test('contents never leak into the next subject or the next semester', () => {
  const { programs } = parseCurriculumRules(DOCUMENT);
  const all = programs[0].semesters.flatMap((s) => s.subjects);
  assert.equal(all.filter((s) => s.outline).length, 1);
});

test('course contents continue across blank lines and stop at the next heading such as "Recommended Books"', () => {
  const text = 'BS Software Engineering\nSemester 1\nSE-101 Intro to SE 3\nContents: Requirements\n\nDesign and testing\n12\n\nRecommended Books\nSommerville';
  const subject = parseCurriculumRules(text).programs[0].semesters[0].subjects[0];
  assert.equal(subject.outline, 'Requirements\n\nDesign and testing');
});

test('list items in the contents start a new line, wrapped sentences are joined', () => {
  const text = 'BS CS\nSemester 1\nCS-104 Functional English 3\nCourse Contents: Divided into functions:\n\nFunction Asking Questions\na) Structure The Present\nPerfect\nb) Reading Guessing';
  const subject = parseCurriculumRules(text).programs[0].semesters[0].subjects[0];
  assert.equal(subject.outline, 'Divided into functions:\n\nFunction Asking Questions\na) Structure The Present Perfect\nb) Reading Guessing');
});

// ---------- the draft cleaner (used for AI output and for the review screen) ----------
test('normalizeDraft keeps course contents and omits the key when there are none', () => {
  const { programs } = normalizeDraft({
    programs: [{ name: 'BS CS', semesters: [{ number: 1, subjects: [
      { code: 'cs 101', title: 'Intro', creditHours: 3, outline: 'Loops and functions' },
      { code: 'cs 102', title: 'Programming', creditHours: 3 },
    ] }] }],
  });
  const [a, b] = programs[0].semesters[0].subjects;
  assert.equal(a.code, 'CS-101');
  assert.equal(a.outline, 'Loops and functions');
  assert.equal('outline' in b, false);
});

test('very long course contents are cut to the 5000 character limit of the database', () => {
  const { programs } = normalizeDraft({
    programs: [{ name: 'BS CS', semesters: [{ number: 1, subjects: [{ code: 'CS-101', title: 'Intro', creditHours: 3, outline: 'x'.repeat(6000) }] }] }],
  });
  assert.equal(programs[0].semesters[0].subjects[0].outline.length, 5000);
});

// ---------- what the teacher is told on assignment ----------
const COURSE = { title: 'Introduction to Computing', code: 'CS-101', creditHours: 3, section: 'A', outline: 'Number systems, algorithms' };

test('the assignment message contains subject, code, credit hours, semester, section, students and contents', () => {
  assert.equal(
    buildAssignmentMessage({ course: COURSE, semesterName: 'BSCS Semester 1', students: 30 }),
    'Introduction to Computing (CS-101) · 3 credit hours · BSCS Semester 1 · Section A · 30 students enrolled. Course contents: Number systems, algorithms'
  );
});

test('the assignment message says so when no contents exist, and uses the singular for one student', () => {
  const msg = buildAssignmentMessage({ course: { ...COURSE, outline: '' }, semesterName: 'BSCS Semester 1', students: 1 });
  assert.match(msg, /1 student enrolled/);
  assert.match(msg, /Course contents have not been added yet\.$/);
});

test('long contents are shortened in the notification so it always fits (the full text is on the course page)', () => {
  const msg = buildAssignmentMessage({ course: { ...COURSE, outline: 'word '.repeat(500) }, semesterName: 'BSCS Semester 1', students: 5 });
  assert.ok(msg.includes('…'));
  assert.ok(msg.length < 1000);
});
