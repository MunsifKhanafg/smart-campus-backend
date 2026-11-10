import test from 'node:test';
import assert from 'node:assert/strict';
import { splitItems, campusText, campusFallback } from '../src/services/campusContext.js';
import { modesFor } from '../src/services/chatModes.js';

const data = {
  user: { name: 'Ali', role: 'student' },
  profile: { rollNumber: 'CS-001', department: 'Computer Science', semester: 'Semester 1', section: 'A' },
  courses: [
    { code: 'ENG101', title: 'English', section: 'A', semester: 'Semester 1', creditHours: 3, teacher: { name: 'Mr Kafeel', email: 'k@x.edu', qualification: 'MA English' }, slots: ['Monday 09:00-10:00 room R1'], contents: ['Grammar', 'Essay writing'], students: undefined },
    { code: 'MTH101', title: 'Maths', section: 'A', semester: 'Semester 1', creditHours: 3, teacher: null, slots: [], contents: [] },
  ],
  teachers: [],
  departments: [],
};

test('course contents are split into items', () => {
  assert.deepEqual(splitItems('Grammar; Essay writing\nLetters'), ['Grammar', 'Essay writing', 'Letters']);
  assert.deepEqual(splitItems('Sets, Functions, Limits'), ['Sets', 'Functions', 'Limits']);
});

test('the campus text numbers the contents and names the teacher', () => {
  const t = campusText(data);
  assert.match(t, /ENG101 - English/);
  assert.match(t, /1\. Grammar/);
  assert.match(t, /2\. Essay writing/);
  assert.match(t, /Mr Kafeel/);
  assert.match(t, /not assigned yet/);
});

test('without an AI key the assistant answers project questions from the data', () => {
  assert.match(campusFallback(data, 'Who teaches my subjects?'), /Mr Kafeel/);
  assert.match(campusFallback(data, 'show course contents'), /1\. Grammar/);
  assert.match(campusFallback(data, 'timetable'), /Monday 09:00-10:00/);
});

test('the "My courses & teachers" option is in the menu of students and staff', () => {
  assert.ok(modesFor('student').some((m) => m.id === 'campus'));
  assert.ok(modesFor('teacher').some((m) => m.id === 'campus'));
  assert.ok(modesFor('hod').some((m) => m.id === 'campus'));
});
