import test from 'node:test';
import assert from 'node:assert/strict';
import { priceNotice, isPayablePhase, endOfDay } from '../src/services/feeService.js';
import { attendancePercent } from '../src/services/attendanceService.js';

const notice = {
  amount: 5000,
  lateFee: 500,
  startDate: new Date('2026-11-01T00:00:00Z'),
  dueDate: new Date('2026-11-10T00:00:00Z'),
  lateDueDate: new Date('2026-11-20T00:00:00Z'),
};
const at = (iso) => new Date(iso);

test('endOfDay keeps a deadline open until the last millisecond of that UTC day', () => {
  assert.equal(endOfDay(at('2026-11-10T05:00:00Z')).toISOString(), '2026-11-10T23:59:59.999Z');
});

test('fee cannot be paid before the collection start date', () => {
  const p = priceNotice(notice, at('2026-10-31T23:00:00Z'));
  assert.equal(p.phase, 'not_started');
  assert.equal(isPayablePhase(p.phase), false);
});

test('fee is the normal amount up to the end of the due date', () => {
  for (const when of ['2026-11-01T00:00:00Z', '2026-11-05T12:00:00Z', '2026-11-10T23:59:00Z']) {
    const p = priceNotice(notice, at(when));
    assert.equal(p.phase, 'normal');
    assert.equal(p.lateFee, 0);
    assert.equal(p.total, 5000);
  }
});

test('after the due date the late fee is added, and the original amount is preserved', () => {
  const p = priceNotice(notice, at('2026-11-11T00:00:00Z'));
  assert.equal(p.phase, 'late');
  assert.equal(p.baseAmount, 5000);
  assert.equal(p.lateFee, 500);
  assert.equal(p.total, 5500);
  assert.equal(isPayablePhase(p.phase), true);
});

test('the late period lasts until the end of the late due date, then the fee is closed', () => {
  assert.equal(priceNotice(notice, at('2026-11-20T23:59:59.999Z')).phase, 'late');
  const closed = priceNotice(notice, at('2026-11-21T00:00:00Z'));
  assert.equal(closed.phase, 'closed');
  assert.equal(isPayablePhase(closed.phase), false);
});

test('when the university disables late fees, payment closes right after the due date', () => {
  assert.equal(priceNotice(notice, at('2026-11-12T00:00:00Z'), false).phase, 'closed');
});

test('a notice without a late deadline closes after the due date', () => {
  const noLate = { ...notice, lateDueDate: null };
  assert.equal(priceNotice(noLate, at('2026-11-12T00:00:00Z')).phase, 'closed');
});

test('attendancePercent: attended divided by classes held', () => {
  assert.equal(attendancePercent({ present: 8, absent: 2 }), 80);
  assert.equal(attendancePercent({ present: 1, absent: 2 }), 33.33);
});

test('attendancePercent: approved leave counts as attended only when the university allows it', () => {
  const counts = { present: 6, absent: 2, leave: 2 };
  assert.equal(attendancePercent(counts, true), 80);
  assert.equal(attendancePercent(counts, false), 60);
});

test('attendancePercent returns null (no data) instead of 0% before any class is held', () => {
  assert.equal(attendancePercent({ present: 0, absent: 0, leave: 0 }), null);
  assert.equal(attendancePercent({}), null);
});
