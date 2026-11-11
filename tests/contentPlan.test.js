import test from 'node:test';
import assert from 'node:assert/strict';
import { classDates, contentItems, planByDates } from '../src/services/contentPlan.js';

test('class days are the timetable weekdays between the start and the end, in date order', () => {
  const { dates } = classDates({ start: '2026-09-07', end: '2026-09-20', weekdays: ['monday', 'wednesday'] });
  assert.deepEqual(dates.map((d) => d.date), ['2026-09-07', '2026-09-09', '2026-09-14', '2026-09-16']);
  assert.ok(dates.every((d) => ['monday', 'wednesday'].includes(d.weekday)));
});

test('holidays, vacations and exam weeks are skipped and reported', () => {
  const r = classDates({
    start: '2026-09-07', end: '2026-09-20', weekdays: ['monday', 'wednesday'],
    blocked: [{ from: '2026-09-09', to: '2026-09-09', label: 'Holiday' }, { from: '2026-09-14', to: '2026-09-18', label: 'Mid-term exams' }],
  });
  assert.deepEqual(r.dates.map((d) => d.date), ['2026-09-07']);
  assert.deepEqual(r.skipped.map((s) => `${s.date} ${s.label}`), ['2026-09-09 Holiday', '2026-09-14 Mid-term exams', '2026-09-16 Mid-term exams']);
});

test('a course with no timetable weekdays has no class days', () => {
  assert.equal(classDates({ start: '2026-09-01', end: '2026-12-01', weekdays: [] }).dates.length, 0);
});

test('numbers and bullets are removed from the contents and the order is kept', () => {
  assert.deepEqual(contentItems('1. Intro\n2) Variables\n- Loops\n• Functions\n\n  Arrays'), ['Intro', 'Variables', 'Loops', 'Functions', 'Arrays']);
  assert.deepEqual(contentItems('Sets; Relations; Functions'), ['Sets', 'Relations', 'Functions']);
  assert.deepEqual(contentItems(''), []);
});

test('equal numbers: one item per class day', () => {
  const dates = ['a', 'b', 'c'].map((d) => ({ date: d, weekday: 'monday' }));
  const plan = planByDates(['x', 'y', 'z'], dates);
  assert.deepEqual(plan.map((p) => p.items.map((i) => i.no)), [[1], [2], [3]]);
  assert.ok(plan.every((p) => !p.continues));
});

test('more class days than items: each item starts on its own day and the following days continue it', () => {
  const dates = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, weekday: 'monday' }));
  const items = Array.from({ length: 10 }, (_, i) => `item ${i + 1}`);
  const plan = planByDates(items, dates);
  const starts = plan.filter((p) => p.items.length);
  assert.equal(starts.length, 10);
  assert.deepEqual(starts.flatMap((p) => p.items.map((i) => i.no)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(plan[1].continues.no, 1);
  assert.equal(plan[39].continues.no, 10);
  assert.equal(plan.filter((p) => !p.items.length && !p.continues).length, 0);
});

test('more items than class days: several items are taught on one day, none is lost, order is kept', () => {
  const dates = Array.from({ length: 10 }, (_, i) => ({ date: `d${i}`, weekday: 'monday' }));
  const items = Array.from({ length: 40 }, (_, i) => `item ${i + 1}`);
  const plan = planByDates(items, dates);
  const all = plan.flatMap((p) => p.items.map((i) => i.no));
  assert.deepEqual(all, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.ok(plan.every((p) => p.items.length === 4));
});

test('odd numbers never lose or repeat an item', () => {
  for (const [n, m] of [[7, 3], [3, 7], [13, 29], [29, 13], [1, 5], [5, 1], [1, 1]]) {
    const plan = planByDates(Array.from({ length: n }, (_, i) => `t${i}`), Array.from({ length: m }, (_, i) => ({ date: `d${i}`, weekday: 'monday' })));
    assert.deepEqual(plan.flatMap((p) => p.items.map((i) => i.no)), Array.from({ length: n }, (_, i) => i + 1), `${n} items over ${m} days`);
  }
});

test('no items or no days gives an empty plan', () => {
  assert.deepEqual(planByDates([], [{ date: 'a', weekday: 'monday' }]), []);
  assert.deepEqual(planByDates(['x'], []), []);
});
