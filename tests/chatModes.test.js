import test from 'node:test';
import assert from 'node:assert/strict';
import { modesFor, findMode, buildSystemPrompt, toModelMessages } from '../src/services/chatModes.js';

test('students get study tools, teachers get teaching tools', () => {
  const s = modesFor('student').map((m) => m.id);
  const t = modesFor('teacher').map((m) => m.id);
  assert.ok(s.includes('plan') && s.includes('quiz') && s.includes('course') && s.includes('general'));
  assert.ok(!s.includes('lesson') && !s.includes('rubric') && !s.includes('questions'));
  assert.ok(t.includes('lesson') && t.includes('rubric') && t.includes('questions') && t.includes('course'));
  assert.ok(!t.includes('plan'));
});

test('an unknown or forbidden mode is not found', () => {
  assert.equal(findMode('student', 'rubric'), null);
  assert.equal(findMode('student', 'nope'), null);
  assert.equal(findMode('hod', 'rubric').id, 'rubric');
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
