import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, makePeriods, toMin, hhmm } from '../src/services/timetableGenerator.js';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const periods = makePeriods(toMin('09:00'), toMin('13:00'), 60);

// 8 semesters x 5 courses x 3 credit hours. 12 teachers are shared between semesters.
const university = () => {
  const classes = [];
  for (let s = 1; s <= 8; s++) {
    for (let c = 1; c <= 5; c++) classes.push({ id: `s${s}c${c}`, group: `sem${s}|A`, teacher: `T${((s * 5 + c) % 12) + 1}`, sessions: 3 });
  }
  return classes;
};
const rooms = Array.from({ length: 9 }, (_, i) => `R-${i + 1}`);

// No teacher, room or semester may appear twice in the same day and period.
const assertNoClashes = (classes, placements) => {
  const by = new Map(classes.map((c) => [c.id, c]));
  const seen = { t: new Set(), r: new Set(), g: new Set() };
  for (const p of placements) {
    const c = by.get(p.classId);
    for (const [k, key] of [['t', `${c.teacher}|${p.day}|${p.period}`], ['r', `${p.room}|${p.day}|${p.period}`], ['g', `${c.group}|${p.day}|${p.period}`]]) {
      assert.ok(!seen[k].has(key), `clash: ${key}`);
      seen[k].add(key);
    }
  }
};

test('4 one-hour periods between 09:00 and 13:00', () => {
  assert.equal(periods.length, 4);
  assert.deepEqual(periods.map((p) => `${hhmm(p.start)}-${hhmm(p.end)}`), ['09:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00']);
});

test('a whole university is scheduled without any clash', () => {
  const classes = university();
  const r = buildSchedule({ classes, days: DAYS, periods, rooms, seed: 3 });
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.placements.length, 8 * 5 * 3);
  assertNoClashes(classes, r.placements);
});

test('each subject is taught on different days where possible', () => {
  const classes = university();
  const r = buildSchedule({ classes, days: DAYS, periods, rooms, seed: 3 });
  for (const c of classes) {
    const days = r.placements.filter((p) => p.classId === c.id).map((p) => p.day);
    assert.equal(new Set(days).size, 3, `${c.id} should use 3 different days`);
  }
});

test('the same seed gives the same timetable, a different seed another one', () => {
  const classes = university();
  const a = buildSchedule({ classes, days: DAYS, periods, rooms, seed: 5 });
  const b = buildSchedule({ classes, days: DAYS, periods, rooms, seed: 5 });
  const c = buildSchedule({ classes, days: DAYS, periods, rooms, seed: 6 });
  assert.deepEqual(a.placements, b.placements);
  assert.notDeepEqual(a.placements, c.placements);
});

test('classes that are already fixed elsewhere are respected', () => {
  const classes = [{ id: 'x', group: 'g', teacher: 'T1', sessions: 3 }];
  // T1 is busy on Monday all morning and room R-1 is taken on Tuesday 09-10
  const existing = [
    { teacher: 'T1', room: 'OTHER', group: 'o', day: 'monday', startMinutes: toMin('09:00'), endMinutes: toMin('13:00') },
    { teacher: 'T9', room: 'R-1', group: 'o2', day: 'tuesday', startMinutes: toMin('09:00'), endMinutes: toMin('10:00') },
  ];
  const r = buildSchedule({ classes, days: DAYS, periods, rooms: ['R-1'], existing, seed: 1 });
  assert.equal(r.unplaced.length, 0);
  assert.ok(r.placements.every((p) => p.day !== 'monday'));
  assert.ok(!r.placements.some((p) => p.day === 'tuesday' && p.period === 0));
});

test('when a semester has more classes than free periods, the rest is reported, never double booked', () => {
  // 25 weekly classes cannot fit into 5 days x 4 periods = 20
  const classes = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, group: 'g', teacher: `T${i}`, sessions: 5 }));
  const r = buildSchedule({ classes, days: DAYS, periods, rooms, seed: 1 });
  assert.equal(r.placements.length, 20);
  assert.equal(r.unplaced.reduce((s, u) => s + u.missing, 0), 5);
  assertNoClashes(classes, r.placements);
});

test('not enough rooms leaves classes unplaced instead of double booking a room', () => {
  const classes = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, group: `g${i}`, teacher: `T${i}`, sessions: 20 }));
  const r = buildSchedule({ classes, days: DAYS, periods, rooms: ['R-1'], seed: 1 });
  assert.equal(r.placements.length, 20); // one room, 20 periods
  assertNoClashes(classes, r.placements);
});
