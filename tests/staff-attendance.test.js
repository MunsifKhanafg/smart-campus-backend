import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinutes, localNow, addDays, weekdayOf, eachDay, distanceMeters, checkInDecision, checkProof } from '../src/services/staffAttendanceRules.js';

const R = { opensAt: '08:00', graceMinutes: 15, absentAfter: '10:00' };

test('check-in is not open before the college starts', () => {
  assert.deepEqual(checkInDecision({ ...R, nowMin: toMinutes('07:30') }), { state: 'not_open', opensInMinutes: 30 });
});

test('on time inside the grace time, late after it, closed after the absent time', () => {
  assert.equal(checkInDecision({ ...R, nowMin: toMinutes('08:00') }).status, 'present');
  assert.equal(checkInDecision({ ...R, nowMin: toMinutes('08:15') }).status, 'present');
  const late = checkInDecision({ ...R, nowMin: toMinutes('08:40') });
  assert.equal(late.status, 'late');
  assert.equal(late.minutesLate, 25);
  assert.equal(checkInDecision({ ...R, nowMin: toMinutes('09:59') }).state, 'late');
  assert.equal(checkInDecision({ ...R, nowMin: toMinutes('10:00') }).state, 'closed');
});

test('the college day follows the college time zone, not the server', () => {
  const n = localNow(new Date('2026-11-11T03:30:00Z'), 'Asia/Karachi');
  assert.equal(n.dateKey, '2026-11-11');
  assert.equal(n.minutes, 8 * 60 + 30);
  assert.equal(localNow(new Date('2026-11-10T20:00:00Z'), 'Asia/Karachi').dateKey, '2026-11-11');
});

test('day helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayOf('2026-11-15'), 'sunday');
  assert.deepEqual(eachDay('2026-11-09', '2026-11-11'), ['2026-11-09', '2026-11-10', '2026-11-11']);
});

test('distance between two points', () => {
  assert.equal(distanceMeters(34.0151, 71.5249, 34.0151, 71.5249), 0);
  const d = distanceMeters(34.0151, 71.5249, 34.0151, 71.5279);
  assert.ok(d > 250 && d < 300, String(d));
});

test('proof of presence: inside the circle, outside it, no location, location too inexact', () => {
  const campus = { lat: 34.0151, lng: 71.5249, radiusMeters: 300 };
  assert.equal(checkProof({ campus: { lat: null, lng: null, radiusMeters: 300 }, maxAccuracyMeters: 200 }).ok, true);
  assert.equal(checkProof({ campus, maxAccuracyMeters: 200 }).ok, false);
  assert.equal(checkProof({ campus, lat: 34.0151, lng: 71.525, accuracy: 20, maxAccuracyMeters: 200 }).ok, true);
  assert.equal(checkProof({ campus, lat: 34.03, lng: 71.54, accuracy: 20, maxAccuracyMeters: 200 }).ok, false);
  assert.equal(checkProof({ campus, lat: 34.0151, lng: 71.525, accuracy: 900, maxAccuracyMeters: 200 }).ok, false);
});
