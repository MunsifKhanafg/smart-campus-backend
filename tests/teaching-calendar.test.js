import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSemesterEnd, dateKey, blockedDays, teachingDates, distribute, planTopicDates, weekdayOf,
} from '../src/services/teachingCalendar.js';

const d = (s) => new Date(`${s}T00:00:00.000Z`);

// ---------- semester end date ----------
test('semester end = start + N weeks - 1 day', () => {
  assert.equal(dateKey(computeSemesterEnd(d('2026-09-07'), 16)), '2026-12-27'); // Monday start, ends Sunday of week 16
  assert.equal(dateKey(computeSemesterEnd(d('2026-01-01'), 1)), '2026-01-07');
});

test('semester end handles invalid input and keeps working when the duration changes', () => {
  assert.equal(computeSemesterEnd(null, 16), null);
  assert.equal(computeSemesterEnd(d('2026-09-07'), 0), null);
  assert.equal(dateKey(computeSemesterEnd(d('2026-09-07'), 18)), '2027-01-10');
  assert.equal(dateKey(computeSemesterEnd(d('2026-09-14'), 16)), '2027-01-03'); // start moved one week -> end moves one week
});

// ---------- non-teaching days ----------
const EVENTS = [
  { type: 'holiday', title: 'Independence Day', startDate: d('2026-08-14'), endDate: d('2026-08-14') },
  { type: 'midterm_exam', title: 'Midterms', startDate: d('2026-10-12'), endDate: d('2026-10-16') },
  { type: 'final_exam', title: 'Finals', startDate: d('2026-12-14'), endDate: d('2026-12-24') },
  { type: 'winter_vacation', title: 'Winter break', startDate: d('2026-12-25'), endDate: d('2027-01-05') },
  { type: 'event', title: 'Sports day', startDate: d('2026-09-20'), endDate: d('2026-09-20') }, // does NOT stop teaching
  { type: 'semester_break', title: 'Break', startDate: d('2026-11-02'), endDate: d('2026-11-03') },
];

test('blockedDays lists exam, vacation, holiday and break days but not ordinary events', () => {
  const b = blockedDays(EVENTS, d('2026-08-01'), d('2027-01-31'));
  assert.ok(b.has('2026-08-14') && b.has('2026-10-14') && b.has('2026-12-20') && b.has('2026-12-31') && b.has('2026-11-03'));
  assert.ok(!b.has('2026-09-20'));
  assert.equal(b.size, 1 + 5 + 11 + 12 + 2);
});

test('blockedDays only returns days inside the requested range', () => {
  const b = blockedDays(EVENTS, d('2026-10-14'), d('2026-10-15'));
  assert.deepEqual([...b.keys()], ['2026-10-14', '2026-10-15']);
});

test('teachingDates never contains Sundays, blocked days or days outside the range', () => {
  const blocked = blockedDays(EVENTS, d('2026-09-07'), d('2026-12-27'));
  const days = teachingDates({ start: d('2026-09-07'), end: d('2026-12-27'), blocked });
  assert.ok(days.length > 50);
  for (const k of days) {
    assert.notEqual(weekdayOf(k), 'sunday');
    assert.ok(!blocked.has(k), `${k} is blocked`);
    assert.ok(k >= '2026-09-07' && k <= '2026-12-27');
  }
  assert.ok(!days.includes('2026-10-13')); // midterm week
  assert.ok(!days.includes('2026-12-16')); // final exam
  assert.ok(days.includes('2026-10-19')); // first Monday after the midterms
});

test('teachingDates follows the teacher\'s own weekdays and extra weekly holidays', () => {
  const days = teachingDates({ start: d('2026-09-07'), end: d('2026-09-20'), teachingDays: ['monday', 'wednesday'] });
  assert.deepEqual(days, ['2026-09-07', '2026-09-09', '2026-09-14', '2026-09-16']);
  const noSat = teachingDates({ start: d('2026-09-07'), end: d('2026-09-13'), weeklyOff: ['sunday', 'saturday'] });
  assert.equal(noSat.length, 5);
  assert.deepEqual(teachingDates({ start: d('2026-09-10'), end: d('2026-09-01') }), []);
});

// ---------- distribution ----------
test('distribute spreads topics evenly and in order', () => {
  const dates = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(distribute(3, dates), ['a', 'c', 'e']);
  assert.deepEqual(distribute(6, dates), dates);
  assert.deepEqual(distribute(12, dates), ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd', 'e', 'e', 'f', 'f']);
  assert.deepEqual(distribute(0, dates), []);
  assert.deepEqual(distribute(5, []), []);
});

test('planTopicDates never places a topic on a holiday, exam day or vacation and stays inside the semester', () => {
  const plan = planTopicDates({ count: 40, start: d('2026-09-07'), end: d('2026-12-27'), events: EVENTS });
  assert.equal(plan.dates.length, 40);
  const bad = new Set(blockedDays(EVENTS, d('2026-09-07'), d('2026-12-27')).keys());
  for (const k of plan.dates) {
    assert.ok(!bad.has(k) && weekdayOf(k) !== 'sunday' && k >= '2026-09-07' && k <= '2026-12-27', k);
  }
  assert.deepEqual([...plan.dates].sort(), plan.dates); // chronological
  assert.equal(plan.firstDay, '2026-09-07');
});

test('recalculation: adding a holiday moves content off that day, removing it brings the day back', () => {
  const base = { count: 30, start: d('2026-09-07'), end: d('2026-12-13') };
  const before = planTopicDates({ ...base, events: [] });
  const extra = [{ type: 'holiday', title: 'Extra', startDate: d('2026-10-05'), endDate: d('2026-10-09') }];
  const after = planTopicDates({ ...base, events: extra });
  assert.ok(after.available < before.available);
  assert.ok(!after.dates.some((k) => k >= '2026-10-05' && k <= '2026-10-09'));
  assert.equal(planTopicDates({ ...base, events: [] }).available, before.available);
});

test('a shorter semester (end date moved earlier) keeps every topic inside the new range', () => {
  const plan = planTopicDates({ count: 20, start: d('2026-09-07'), end: d('2026-11-01'), events: EVENTS });
  assert.ok(plan.dates.every((k) => k <= '2026-11-01'));
});

test('no teaching day available gives an empty plan instead of crashing', () => {
  const all = [{ type: 'holiday', title: 'Closed', startDate: d('2026-09-07'), endDate: d('2026-09-13') }];
  const plan = planTopicDates({ count: 5, start: d('2026-09-07'), end: d('2026-09-13'), events: all });
  assert.deepEqual(plan.dates, []);
  assert.equal(plan.available, 0);
  assert.equal(plan.firstDay, null);
});
