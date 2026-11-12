import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSemesterDates, startYearOf } from '../src/services/semesterDates.js';

const ev = (type, title, s, e = s, department = null) => ({ type, title, startDate: s, endDate: e, department });
const year = [
  ev('semester_start', 'Fall starts', '2026-09-01'),
  ev('midterm_exam', 'Mid', '2026-10-26', '2026-11-06'),
  ev('semester_end', 'Fall ends', '2026-12-31'),
  ev('winter_vacation', 'Winter', '2027-01-04', '2027-01-17'),
  ev('semester_start', 'Spring starts', '2027-01-19'),
  ev('semester_end', 'Spring ends', '2027-06-05'),
  ev('summer_vacation', 'Summer', '2027-06-08', '2027-08-31'),
];

test('academic year text gives its first year', () => {
  assert.equal(startYearOf('2026-2027'), 2026);
  assert.equal(startYearOf('2026'), 2026);
  assert.equal(startYearOf('next year'), null);
});

test('odd semesters take the first term, even semesters the second', () => {
  for (const n of [1, 3, 5, 7]) {
    const r = pickSemesterDates({ events: year, number: n, startYear: 2026, departmentId: 'd1' });
    assert.equal(r.startDate, '2026-09-01'); assert.equal(r.endDate, '2026-12-31');
  }
  for (const n of [2, 4, 6, 8]) {
    const r = pickSemesterDates({ events: year, number: n, startYear: 2026, departmentId: 'd1' });
    assert.equal(r.startDate, '2027-01-19'); assert.equal(r.endDate, '2027-06-05');
  }
});

test('events of another academic year are ignored', () => {
  const r = pickSemesterDates({ events: [...year, ev('semester_start', 'Old', '2025-09-01'), ev('semester_end', 'Old end', '2025-12-20')], number: 1, startYear: 2026, departmentId: 'd1' });
  assert.equal(r.startDate, '2026-09-01');
  assert.equal(pickSemesterDates({ events: year, number: 1, startYear: 2030, departmentId: 'd1' }).found, false);
});

test('the department\'s own semester events replace the university ones', () => {
  const own = [ev('semester_start', 'CS fall', '2026-09-08', '2026-09-08', 'd1'), ev('semester_end', 'CS fall end', '2026-12-18', '2026-12-18', 'd1'),
    ev('semester_start', 'CS spring', '2027-02-01', '2027-02-01', 'd1'), ev('semester_end', 'CS spring end', '2027-06-12', '2027-06-12', 'd1')];
  const r = pickSemesterDates({ events: [...year, ...own], number: 3, startYear: 2026, departmentId: 'd1' });
  assert.equal(r.source, 'department'); assert.equal(r.startDate, '2026-09-08'); assert.equal(r.endDate, '2026-12-18');
  // another department keeps the university calendar
  const other = pickSemesterDates({ events: [...year, ...own], number: 3, startYear: 2026, departmentId: 'd2' });
  assert.equal(other.source, 'university'); assert.equal(other.startDate, '2026-09-01');
});

test('a missing second term or a missing end is reported, not invented', () => {
  const onlyFall = [ev('semester_start', 'Fall', '2026-09-01'), ev('semester_end', 'Fall end', '2026-12-31')];
  const spring = pickSemesterDates({ events: onlyFall, number: 2, startYear: 2026, departmentId: 'd1' });
  assert.equal(spring.found, false); assert.match(spring.reason, /second semester starts/);
  const noEnd = pickSemesterDates({ events: [ev('semester_start', 'Fall', '2026-09-01')], number: 1, startYear: 2026, departmentId: 'd1' });
  assert.equal(noEnd.found, true); assert.equal(noEnd.endDate, null);
});

test('the end of the fall term is never taken from the spring term', () => {
  const r = pickSemesterDates({ events: [ev('semester_start', 'Fall', '2026-09-01'), ev('semester_start', 'Spring', '2027-01-19'), ev('semester_end', 'Spring ends', '2027-06-05')], number: 1, startYear: 2026, departmentId: 'd1' });
  assert.equal(r.endDate, null);
});
