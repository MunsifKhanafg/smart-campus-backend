import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestion, peopleFallback } from '../src/services/peopleContext.js';
import { modesFor, findMode } from '../src/services/chatModes.js';

const depts = [
  { _id: '1', code: 'CS', name: 'Computer Science' },
  { _id: '2', code: 'SE', name: 'Software Engineering' },
];

test('the question is understood: kind of people, department, semester, names', () => {
  const a = parseQuestion('List all teachers of computer science', depts);
  assert.equal(a.wantsTeachers, true);
  assert.equal(a.dept.code, 'CS');
  const b = parseQuestion('show students of semester 3 in SE', depts);
  assert.equal(b.wantsStudents, true);
  assert.equal(b.semester, 3);
  assert.equal(b.dept.code, 'SE');
  const c = parseQuestion('details of Kafeel', depts);
  assert.deepEqual(c.tokens, ['kafeel']);
  assert.equal(c.wantsStudents, false);
});

test('only the principal and HODs get the students & teachers option', () => {
  assert.ok(findMode('hod', 'people'));
  assert.ok(findMode('university_head', 'people'));
  assert.equal(findMode('student', 'people'), null);
  assert.equal(findMode('teacher', 'people'), null);
  assert.ok(!modesFor('teacher').some((m) => m.id === 'people'));
});

test('without an AI key the people are shown as tables', () => {
  const data = {
    scope: 'your department', departments: [{ name: 'Computer Science', code: 'CS', hod: 'Dr A', teachers: 1, students: 2 }], perSemester: [],
    teachers: [{ name: 'Mr Kafeel', role: 'Teacher', department: 'CS', email: 'k@x.edu', phone: '0300', qualification: 'MS', subjects: ['ENG101 English (Semester 1, sec A)'], creditHours: 3, weeklyClasses: 4 }],
    students: [], studentsTotal: 0, matches: { students: [], teachers: [] }, question: { wantsDepartments: false },
  };
  const md = peopleFallback(data);
  assert.match(md, /\| Name \| Role \|/);
  assert.match(md, /Mr Kafeel/);
  assert.match(md, /ENG101 English/);
});
