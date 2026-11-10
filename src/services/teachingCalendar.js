// ============================================================================================
// Academic-calendar maths. Pure functions only (no database), so they are easy to unit test.
//
// All dates are handled as UTC calendar days ("YYYY-MM-DD" keys). The date inputs of the web pages are stored as
// UTC midnight, so using UTC everywhere means a day never shifts because of the server's time zone.
// ============================================================================================

import { DEFAULT_SEMESTER_WEEKS } from './semesterDates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']; // Date#getUTCDay order

// Calendar events of these types are days on which NOTHING is taught.
// (semester_start, semester_end and plain "event" entries do not stop teaching.)
export const NON_TEACHING_EVENT_TYPES = ['holiday', 'midterm_exam', 'final_exam', 'summer_vacation', 'winter_vacation', 'semester_break'];

export const DEFAULT_WEEKLY_OFF = ['sunday'];
export const DEFAULT_TEACHING_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// One default for the whole system: semesterDates.js (the Semester model uses the same value).
export { DEFAULT_SEMESTER_WEEKS };

export const dateKey = (d) => new Date(d).toISOString().slice(0, 10);
export const fromKey = (key) => new Date(`${key}T00:00:00.000Z`);
export const dateOnly = (d) => fromKey(dateKey(d));
export const addDays = (d, n) => new Date(dateOnly(d).getTime() + n * DAY_MS);
export const weekdayOf = (key) => WEEKDAYS[fromKey(key).getUTCDay()];

// End date of a semester: the start date plus N whole weeks, minus one day.
// (Start Monday 1 Sep with 16 weeks ends Sunday 21 Dec, the last day of week 16.)
export const computeSemesterEnd = (startDate, weeks = DEFAULT_SEMESTER_WEEKS) => {
  const w = Number(weeks);
  if (!startDate || !Number.isFinite(w) || w < 1) return null;
  return addDays(startDate, Math.round(w) * 7 - 1);
};

// Every non-teaching day in [from, to] that comes from a calendar event. Returns Map(dateKey -> reason).
export const blockedDays = (events = [], from, to) => {
  const lo = dateKey(from);
  const hi = dateKey(to);
  const out = new Map();
  for (const e of events) {
    if (!NON_TEACHING_EVENT_TYPES.includes(e.type)) continue;
    let k = dateKey(e.startDate) > lo ? dateKey(e.startDate) : lo;
    const last = dateKey(e.endDate) < hi ? dateKey(e.endDate) : hi;
    for (; k <= last; k = dateKey(addDays(fromKey(k), 1))) {
      if (!out.has(k)) out.set(k, e.title || e.type);
    }
  }
  return out;
};

// The days a class can really be taught: inside [start, end], on one of the teacher's teaching weekdays,
// not on a weekly holiday (Sunday by default) and not on a blocked calendar day.
export const teachingDates = ({ start, end, teachingDays = DEFAULT_TEACHING_DAYS, weeklyOff = DEFAULT_WEEKLY_OFF, blocked = new Map() }) => {
  if (!start || !end || dateKey(end) < dateKey(start)) return [];
  const days = new Set(teachingDays.length ? teachingDays : DEFAULT_TEACHING_DAYS);
  const off = new Set(weeklyOff);
  const out = [];
  const last = dateKey(end);
  for (let k = dateKey(start); k <= last; k = dateKey(addDays(fromKey(k), 1))) {
    const wd = weekdayOf(k);
    if (days.has(wd) && !off.has(wd) && !blocked.has(k)) out.push(k);
  }
  return out;
};

// Spreads `count` topics evenly over the available teaching dates, in order.
// Fewer topics than days: they are spaced out. More topics than days: several topics share a day.
export const distribute = (count, dates) => {
  if (!count || !dates.length) return [];
  return Array.from({ length: count }, (_, i) => dates[Math.floor((i * dates.length) / count)]);
};

// The whole plan in one call. Returns the date of each topic plus what was skipped and why.
export const planTopicDates = ({ count, start, end, teachingDays, weeklyOff = DEFAULT_WEEKLY_OFF, events = [] }) => {
  const blocked = blockedDays(events, start, end);
  const available = teachingDates({ start, end, teachingDays, weeklyOff, blocked });
  const dates = distribute(count, available);
  const skipped = [...blocked].map(([date, reason]) => ({ date, reason })).sort((a, b) => a.date.localeCompare(b.date));
  return { dates, available: available.length, skipped, firstDay: available[0] || null, lastDay: available[available.length - 1] || null };
};
