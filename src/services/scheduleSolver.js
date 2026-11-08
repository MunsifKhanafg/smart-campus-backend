// ============================================================================================
// Timetable solver. Pure code (no database, no AI), so it can be unit tested and always behaves the same for the same seed.
//
// It places every weekly class hour of a semester into a day and a period, and picks a room, so that:
//   * a teacher is never in two places at once (also not against classes of other semesters: `busy.teachers`)
//   * a room is never used twice at the same time (also against other semesters: `busy.rooms`)
//   * the students of one section (`group`) never have two classes at the same time
//   * nobody teaches at a time that was blocked (`blocked`: "Friday is off for Dr Ahmed")
// and, as far as possible:
//   * the lessons of one course are spread over different days (never twice on the same day if another day is free)
//   * the load is balanced over the week and classes of a section / teacher sit next to each other (few gaps)
//
// It is a greedy placement repeated with different random tie-breaks (restarts); the best attempt wins. Every attempt only
// ever makes placements that pass all the checks above, so the result can never contain a clash. What does not fit is
// returned in `unplaced` with the reason, so the HOD can fix it by hand instead of getting a wrong timetable.
// ============================================================================================

export const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
export const fmtTime = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// 09:00 to 13:00 with 60 minute classes -> 4 periods: 09:00-10:00, 10:00-11:00, 11:00-12:00, 12:00-13:00
export const buildPeriods = (start = '09:00', end = '13:00', classMinutes = 60) => {
  const periods = [];
  for (let s = toMin(start); s + classMinutes <= toMin(end); s += classMinutes) periods.push({ start: s, end: s + classMinutes });
  return periods;
};

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

// Small seeded random generator (mulberry32): the same seed always gives the same timetable.
const prng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// lessons: [{ id, code, teacher, group, hours }]   (hours = class hours per week = credit hours)
// days: ['monday', ...]   periods: from buildPeriods()   rooms: ['R-101', ...]
// busy: { teachers: Map(teacherId -> [{ day, start, end }]), rooms: Map(room -> [{ day, start, end }]) }  classes already fixed elsewhere
// blocked: [{ teacher: id | null, days: [] (empty = every day), periods: [] (0-based, empty = every period) }]  null teacher = nobody
export const solveTimetable = ({ lessons, days, periods, rooms, busy = {}, blocked = [], seed = 1, attempts = 40 }) => {
  const busyTeachers = busy.teachers || new Map();
  const busyRooms = busy.rooms || new Map();
  const external = (map, key, day, p) => (map.get(key) || []).some((x) => x.day === day && overlaps(x.start, x.end, p.start, p.end));
  const isBlocked = (teacher, day, pi) =>
    blocked.some((b) => (!b.teacher || b.teacher === teacher) && (!b.days?.length || b.days.includes(day)) && (!b.periods?.length || b.periods.includes(pi)));

  const requestedHours = lessons.reduce((n, l) => n + l.hours, 0);
  const teacherHours = new Map();
  lessons.forEach((l) => teacherHours.set(l.teacher, (teacherHours.get(l.teacher) || 0) + l.hours));

  const attempt = (n) => {
    const rnd = prng(seed * 1000003 + n * 7919);
    const teacherOcc = new Set();
    const roomOcc = new Set();
    const groupOcc = new Set();
    const courseDay = new Set();
    const groupDay = new Map();
    const teacherDay = new Map();
    const lastRoom = new Map();
    const placed = [];
    const unplaced = [];
    let cost = 0;

    const roomFor = (l, day, pi, p) => {
      const preferred = lastRoom.get(l.id);
      const order = preferred ? [preferred, ...rooms.filter((r) => r !== preferred)] : rooms;
      return order.find((r) => !roomOcc.has(`${r}|${day}|${pi}`) && !external(busyRooms, r, day, p)) || null;
    };

    // Hardest first: teachers with the most hours, then long courses. Hour by hour in turns, so no course hogs the best periods.
    const order = lessons
      .map((l) => ({ l, r: rnd() }))
      .sort((a, b) => teacherHours.get(b.l.teacher) - teacherHours.get(a.l.teacher) || b.l.hours - a.l.hours || a.r - b.r)
      .map((x) => x.l);
    const longest = Math.max(0, ...order.map((l) => l.hours));

    const why = (l) => {
      let groupFree = 0;
      let teacherFree = 0;
      for (const day of days) {
        for (let pi = 0; pi < periods.length; pi += 1) {
          if (!groupOcc.has(`${l.group}|${day}|${pi}`)) groupFree += 1;
          if (!teacherOcc.has(`${l.teacher}|${day}|${pi}`) && !isBlocked(l.teacher, day, pi) && !external(busyTeachers, l.teacher, day, periods[pi])) teacherFree += 1;
        }
      }
      if (!groupFree) return `No free period is left for section ${l.group} (every period of the week is already used)`;
      if (!teacherFree) return 'The teacher has no free period left (busy in other semesters, blocked, or already teaching)';
      return 'No free room at a time that suits both the section and the teacher';
    };

    for (let h = 0; h < longest; h += 1) {
      for (const l of order) {
        if (l.hours <= h) continue;
        let best = null;
        for (const day of days) {
          for (let pi = 0; pi < periods.length; pi += 1) {
            const p = periods[pi];
            if (teacherOcc.has(`${l.teacher}|${day}|${pi}`) || groupOcc.has(`${l.group}|${day}|${pi}`)) continue;
            if (isBlocked(l.teacher, day, pi) || external(busyTeachers, l.teacher, day, p)) continue;
            const room = roomFor(l, day, pi, p);
            if (!room) continue;

            let score = rnd(); // random tie-break, different in every attempt
            if (courseDay.has(`${l.id}|${day}`)) score += 100; // the same course twice in a day only when nothing else is left
            score += 3 * (groupDay.get(`${l.group}|${day}`) || 0); // keep the days of the week evenly loaded
            score += 2 * (teacherDay.get(`${l.teacher}|${day}`) || 0);
            score += pi * 0.4; // slightly prefer earlier periods
            if (groupOcc.has(`${l.group}|${day}|${pi - 1}`) || groupOcc.has(`${l.group}|${day}|${pi + 1}`)) score -= 1.5; // no gaps for the students
            if (teacherOcc.has(`${l.teacher}|${day}|${pi - 1}`) || teacherOcc.has(`${l.teacher}|${day}|${pi + 1}`)) score -= 1; // and few for the teacher
            if (!best || score < best.score) best = { day, pi, room, score };
          }
        }
        if (!best) { unplaced.push({ id: l.id, code: l.code, reason: why(l) }); continue; }

        const p = periods[best.pi];
        teacherOcc.add(`${l.teacher}|${best.day}|${best.pi}`);
        groupOcc.add(`${l.group}|${best.day}|${best.pi}`);
        roomOcc.add(`${best.room}|${best.day}|${best.pi}`);
        courseDay.add(`${l.id}|${best.day}`);
        groupDay.set(`${l.group}|${best.day}`, (groupDay.get(`${l.group}|${best.day}`) || 0) + 1);
        teacherDay.set(`${l.teacher}|${best.day}`, (teacherDay.get(`${l.teacher}|${best.day}`) || 0) + 1);
        lastRoom.set(l.id, best.room);
        cost += best.score;
        placed.push({ id: l.id, code: l.code, teacher: l.teacher, group: l.group, room: best.room, day: best.day, start: p.start, end: p.end });
      }
    }
    return { placed, unplaced, cost };
  };

  let best = null;
  for (let n = 0; n < attempts; n += 1) {
    const r = attempt(n);
    if (!best || r.unplaced.length < best.unplaced.length || (r.unplaced.length === best.unplaced.length && r.cost < best.cost)) best = r;
  }
  return { placed: best.placed, unplaced: best.unplaced, requestedHours, placedHours: best.placed.length, attempts };
};
