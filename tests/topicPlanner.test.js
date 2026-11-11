import test from 'node:test';
import assert from 'node:assert/strict';
import { planTopicDays, carryForward, seededRandom, MIN_PER_CLASS, MAX_PER_CLASS } from '../src/services/topicPlanner.js';

const range = (n) => Array.from({ length: n }, (_, i) => (i + 1) * 1000);
const perDay = (slots) => {
  const m = new Map();
  slots.forEach((s) => m.set(s, (m.get(s) || 0) + 1));
  return [...m.values()];
};

test('every class gets 2 to 3 topics and every topic is placed, in order, on a given teaching day', () => {
  for (const [count, days] of [[30, 40], [7, 10], [45, 30], [12, 60], [3, 5]]) {
    const d = range(days);
    const plan = planTopicDays(count, d);
    assert.equal(plan.slots.length, count);
    assert.deepEqual([...plan.slots].sort((a, b) => a - b), plan.slots, 'topics stay in course order');
    assert.ok(plan.slots.every((s) => d.includes(s)));
    if (count >= MIN_PER_CLASS) for (const n of perDay(plan.slots)) assert.ok(n >= 1 && n <= MAX_PER_CLASS, `${count}/${days}: ${n}`);
    assert.equal(plan.overCapacity, false);
  }
});

test('the plan is repeatable without a random generator', () => {
  const d = range(25);
  assert.deepEqual(planTopicDays(40, d).slots, planTopicDays(40, d).slots);
});

test('a short semester still places every topic (the course finishes) and says it is over capacity', () => {
  const plan = planTopicDays(10, range(2));
  assert.equal(plan.slots.length, 10);
  assert.equal(plan.overCapacity, true);
});

test('no teaching days left gives an empty plan instead of crashing', () => {
  const plan = planTopicDays(5, []);
  assert.deepEqual(plan.slots, []);
});

test('Regenerate Schedule (random plan) keeps the rules and can give a different arrangement', () => {
  const d = range(40);
  const base = planTopicDays(30, d).slots.join();
  let different = false;
  for (let seed = 1; seed <= 10; seed += 1) {
    const plan = planTopicDays(30, d, { rng: seededRandom(seed) });
    assert.equal(plan.slots.length, 30);
    assert.deepEqual([...plan.slots].sort((a, b) => a - b), plan.slots);
    for (const n of perDay(plan.slots)) assert.ok(n >= MIN_PER_CLASS && n <= MAX_PER_CLASS, `seed ${seed}: ${n}`);
    if (plan.slots.join() !== base) different = true;
  }
  assert.ok(different, 'at least one regenerated plan differs from the first plan');
});

test('absent teacher: the topics of the missed day move to the next day and the rest shift so no class exceeds 3', () => {
  const load = new Map([
    [1, [{ id: 'a', fixed: false }, { id: 'b', fixed: false }, { id: 'c', fixed: false }]],
    [2, [{ id: 'd', fixed: false }, { id: 'e', fixed: false }]],
  ]);
  const { placed, stuck, overCapacity } = carryForward({ days: [1, 2, 3], load, moved: [{ id: 'x' }, { id: 'y' }] });
  assert.deepEqual(stuck, []);
  assert.equal(overCapacity, false);
  assert.deepEqual(placed.get(1).map((t) => t.id), ['x', 'y', 'a']);
  assert.deepEqual(placed.get(2).map((t) => t.id), ['b', 'c', 'd']);
  assert.deepEqual(placed.get(3).map((t) => t.id), ['e']);
  for (const list of placed.values()) assert.ok(list.length <= MAX_PER_CLASS);
});

test('absent teacher: a topic the teacher dated by hand is never pushed away', () => {
  const load = new Map([[1, [{ id: 'f', fixed: true }, { id: 'a', fixed: false }]]]);
  const { placed } = carryForward({ days: [1, 2], load, moved: [{ id: 'x' }, { id: 'y' }] });
  assert.ok(placed.get(1).some((t) => t.id === 'f'));
  assert.deepEqual(placed.get(2).map((t) => t.id), ['a']);
});

test('absent teacher on the last day of the semester: nothing is dropped, the last class just carries more', () => {
  const { placed, overCapacity, stuck } = carryForward({ days: [1], moved: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  assert.equal(overCapacity, true);
  assert.deepEqual(stuck, []);
  assert.equal(placed.get(1).length, 4);
});

test('absent teacher with no teaching day left reports the topics as stuck', () => {
  const { stuck } = carryForward({ days: [], moved: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(stuck, ['a', 'b']);
});
