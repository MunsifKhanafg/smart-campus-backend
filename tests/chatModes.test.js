import test from 'node:test';
import assert from 'node:assert/strict';
import { modesFor, findMode, buildSystemPrompt, toModelMessages } from '../src/services/chatModes.js';

// The assistant is ONE search box (records search) for the principal, the HODs and the finance office.
// The menu of study tools was removed on purpose.

test('the principal, HODs and finance office get exactly one option: the records search', () => {
  for (const role of ['university_head', 'hod', 'finance_officer']) {
    assert.deepEqual(modesFor(role).map((m) => m.id), ['records']);
  }
});

test('students and teachers do not get the assistant at all', () => {
  assert.deepEqual(modesFor('student'), []);
  assert.deepEqual(modesFor('teacher'), []);
});

test('a removed or unknown option is not found, so it cannot be opened by sending its id', () => {
  for (const id of ['general', 'explain', 'solve', 'summarize', 'quiz', 'plan', 'writing', 'translate', 'code', 'lesson', 'questions', 'rubric', 'people', 'campus', 'course', 'nope']) {
    assert.equal(findMode('hod', id), null, id);
  }
  assert.equal(findMode('hod', 'records').id, 'records');
});

test('the records option keeps its search hint (roll number, attendance, fees)', () => {
  const m = modesFor('hod')[0];
  assert.match(m.placeholder, /attendance of/);
  assert.match(m.placeholder, /fees of/);
});

test('the system prompt always carries the safety rules and the role rule', () => {
  const p = buildSystemPrompt('student', 'quiz');
  assert.match(p, /never decide or change marks/);
  assert.match(p, /student/);
  assert.match(p, /multiple choice/);
  assert.match(buildSystemPrompt('teacher', 'general'), /teacher or staff/);
});

test('model messages start with a user turn and alternate', () => {
  const stored = [
    { role: 'assistant', content: 'a0' }, { role: 'user', content: 'u1' }, { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u3' },
  ];
  const m = toModelMessages(stored);
  assert.equal(m[0].role, 'user');
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[0].content, 'u1\nu2');
});

test('only the most recent messages are sent', () => {
  const stored = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  assert.ok(toModelMessages(stored, 10).length <= 10);
});
