import { toMinutes } from '../models/TimetableSlot.js';

// ============================================================================================
// Automatic timetable ("smart scheduler").
//
// The classes of a semester are placed into one-hour periods of the working day (default 09:00 to 13:00 = four periods) on
// the chosen weekdays. A constraint solver is used on purpose instead of asking a language model to type a timetable:
// a model cannot guarantee that no teacher, room or class is double booked, this code can.
//
// Rules that are always kept:
//   1. a teacher is never in two places at the same time, in ANY semester or department;
//   2. a room is never used by two classes at the same time;
//   3. the students of one section never have two classes at the same time;
//   4. a course gets exactly its credit hours per week (1 credit hour = 1 hour);
// Preferences (not guaranteed): the lessons of one course fall on different days, every day of a section gets a similar
// number of lessons, and earlier periods are used first so the day ends early.
// This file has no database access, so it can be unit tested.
// ============================================================================================

export const DEFAULT_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

const pad = (n) => String(n).padStart(2, '0');
export const clock = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// [{ start, end }] in minutes: 09:00-13:00 with 60 minute periods -> 4 periods.
export const buildGrid = ({ startTime = '09:00', endTime = '13:00', slotMinutes = 60 }) => {
  const grid = [];
  for (let m = toMinutes(startTime); m + slotMinutes <= toMinutes(endTime); m += slotMinutes) grid.push({ start: m, end: m + slotMinutes });
  return grid;
};

// "Is this resource busy in this period?" is a Set of strings such as `teacherId|monday|540`.
export const keyOf = (id, day, start) => `${id}|${day}|${start}`;

// Marks every period of the grid that an existing class overlaps as busy.
export const markBusy = (busy, grid, slot) => {
  for (const g of grid) {
    if (slot.startMinutes < g.end && slot.endMinutes > g.start) {
      if (slot.teacher) busy.teacher.add(keyOf(slot.teacher, slot.day, g.start));
      if (slot.room) busy.room.add(keyOf(slot.room, slot.day, g.start));
      if (slot.group) busy.group.add(keyOf(slot.group, slot.day, g.start));
    }
  }
};

export const emptyBusy = () => ({ teacher: new Set(), room: new Set(), group: new Set() });

// lessons: [{ courseId, code, title, teacherId, group, hours }]   (hours = lessons still to place this week)
// Returns { placed: [{ courseId, teacherId, group, room, day, start, end }], unplaced: [{ courseId, code, missing, reason }] }
export const scheduleLessons = ({ lessons, grid, days, rooms, busy }) => {
  const placed = [];
  const unplaced = [];
  const teacherLessons = new Map();
  lessons.forEach((l) => teacherLessons.set(l.teacherId, (teacherLessons.get(l.teacherId) || 0) + l.hours));

  const groupDay = new Map(); // group|day -> lessons placed
  const teacherDay = new Map(); // teacher|day -> lessons placed
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  // The hardest courses first: most hours, then teachers with the most lessons.
  const order = [...lessons].sort(
    (a, b) => b.hours - a.hours || teacherLessons.get(b.teacherId) - teacherLessons.get(a.teacherId) || a.code.localeCompare(b.code)
  );

  for (const lesson of order) {
    const usedDays = new Set();
    let lastRoom = null;
    let left = lesson.hours;

    while (left > 0) {
      let best = null;
      for (const day of days) {
        for (const [index, g] of grid.entries()) {
          if (busy.teacher.has(keyOf(lesson.teacherId, day, g.start))) continue;
          if (busy.group.has(keyOf(lesson.group, day, g.start))) continue;
          const free = rooms.filter((r) => !busy.room.has(keyOf(r, day, g.start)));
          if (!free.length) continue;
          const room = free.includes(lastRoom) ? lastRoom : free[0];
          const score =
            (usedDays.has(day) ? 1000 : 0) + // one lesson of a course per day when possible
            (groupDay.get(`${lesson.group}|${day}`) || 0) * 20 + // keep every day of the section similarly full
            (teacherDay.get(`${lesson.teacherId}|${day}`) || 0) * 5 + // do not pile all of a teacher's lessons on one day
            index; // earlier periods first
          if (!best || score < best.score) best = { day, g, room, score };
        }
      }
      if (!best) break;

      busy.teacher.add(keyOf(lesson.teacherId, best.day, best.g.start));
      busy.group.add(keyOf(lesson.group, best.day, best.g.start));
      busy.room.add(keyOf(best.room, best.day, best.g.start));
      bump(groupDay, `${lesson.group}|${best.day}`);
      bump(teacherDay, `${lesson.teacherId}|${best.day}`);
      usedDays.add(best.day);
      lastRoom = best.room;
      placed.push({ courseId: lesson.courseId, teacherId: lesson.teacherId, group: lesson.group, room: best.room, day: best.day, start: best.g.start, end: best.g.end });
      left -= 1;
    }

    if (left > 0) {
      unplaced.push({
        courseId: lesson.courseId,
        code: lesson.code,
        missing: left,
        reason: 'No period was free: the teacher, the section or every room is already busy in all periods. Add rooms or days, or give the course to another teacher.',
      });
    }
  }
  return { placed, unplaced };
};
