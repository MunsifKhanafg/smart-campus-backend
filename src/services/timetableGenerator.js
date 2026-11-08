// ============================================================================================
// Automatic timetable ("smart scheduler").
//
// A constraint solver is used on purpose instead of asking a language model to type a timetable: a model cannot
// guarantee that nobody is double booked, this code can. It never touches the database, so it is easy to unit test.
//
// Always kept (hard rules):
//   1. a teacher is never in two places at the same time;
//   2. a room is never used by two classes at the same time;
//   3. the students of one group (semester + section) never have two classes at the same time;
//   4. a class gets exactly its number of sessions per week, or the missing ones are reported (never forced in).
// Preferences: the sessions of one subject fall on different days, every day of a group is similarly full, and
// earlier periods are used first. Several randomised attempts are made (the seed makes them repeatable) and the
// best one is returned.
// ============================================================================================

const pad = (n) => String(n).padStart(2, '0');
export const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
export const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// [{ start, end }] in minutes. 09:00-13:00 with 60 minute periods gives 4 periods. The index in the array is the "period".
export const makePeriods = (startMin, endMin, length = 60) => {
  const periods = [];
  for (let m = startMin; m + length <= endMin; m += length) periods.push({ start: m, end: m + length });
  return periods;
};

// Small repeatable random number generator (mulberry32).
const makeRandom = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const key = (id, day, period) => `${id}|${day}|${period}`;

// classes:  [{ id, group, teacher, sessions }]     (sessions = lessons still to place this week)
// existing: [{ teacher, room, group, day, startMinutes, endMinutes }]  classes that are already fixed (any may be null)
// returns:  { placements: [{ classId, day, period, room, start, end }], unplaced: [{ classId, missing }] }
export const buildSchedule = ({ classes, days, periods, rooms, existing = [], seed = 1, attempts = 300 }) => {
  const base = { t: new Set(), r: new Set(), g: new Set() };
  for (const e of existing) {
    periods.forEach((p, index) => {
      if (e.startMinutes < p.end && e.endMinutes > p.start) {
        if (e.teacher) base.t.add(key(e.teacher, e.day, index));
        if (e.room) base.r.add(key(e.room, e.day, index));
        if (e.group) base.g.add(key(e.group, e.day, index));
      }
    });
  }
  const teacherSessions = new Map();
  classes.forEach((c) => teacherSessions.set(c.teacher, (teacherSessions.get(c.teacher) || 0) + c.sessions));

  const attempt = (rand) => {
    const busy = { t: new Set(base.t), r: new Set(base.r), g: new Set(base.g) };
    const placements = [];
    const left = new Map(classes.map((c) => [c.id, c.sessions]));
    const usedDays = new Map(classes.map((c) => [c.id, new Set()]));
    const lastRoom = new Map();
    const groupDay = new Map();
    const teacherDay = new Map();
    const stuck = new Set();
    let repeats = 0;

    // Hardest classes first (many sessions, busy teacher); the random part makes every seed a little different.
    const order = classes
      .map((c) => ({ c, rank: c.sessions * 10 + teacherSessions.get(c.teacher) + rand() * 12 }))
      .sort((a, b) => b.rank - a.rank)
      .map((x) => x.c);

    // One session of every class per round, so no class takes all the best periods.
    for (let progress = true; progress; ) {
      progress = false;
      for (const c of order) {
        if (left.get(c.id) <= 0 || stuck.has(c.id)) continue;
        let best = null;
        for (const day of days) {
          for (let period = 0; period < periods.length; period += 1) {
            if (busy.t.has(key(c.teacher, day, period)) || busy.g.has(key(c.group, day, period))) continue;
            const free = rooms.filter((r) => !busy.r.has(key(r, day, period)));
            if (!free.length) continue;
            const score =
              (usedDays.get(c.id).has(day) ? 1000 : 0) +
              (groupDay.get(`${c.group}|${day}`) || 0) * 20 +
              (teacherDay.get(`${c.teacher}|${day}`) || 0) * 5 +
              period * 0.5 +
              rand() * 3;
            if (!best || score < best.score) best = { day, period, free, score };
          }
        }
        if (!best) { stuck.add(c.id); continue; } // busy sets only grow, so this class can take no more sessions
        const room = best.free.includes(lastRoom.get(c.id)) ? lastRoom.get(c.id) : best.free[0];
        busy.t.add(key(c.teacher, best.day, best.period));
        busy.g.add(key(c.group, best.day, best.period));
        busy.r.add(key(room, best.day, best.period));
        if (usedDays.get(c.id).has(best.day)) repeats += 1;
        usedDays.get(c.id).add(best.day);
        lastRoom.set(c.id, room);
        groupDay.set(`${c.group}|${best.day}`, (groupDay.get(`${c.group}|${best.day}`) || 0) + 1);
        teacherDay.set(`${c.teacher}|${best.day}`, (teacherDay.get(`${c.teacher}|${best.day}`) || 0) + 1);
        placements.push({ classId: c.id, day: best.day, period: best.period, room, start: periods[best.period].start, end: periods[best.period].end });
        left.set(c.id, left.get(c.id) - 1);
        progress = true;
      }
    }
    const unplaced = classes.filter((c) => left.get(c.id) > 0).map((c) => ({ classId: c.id, missing: left.get(c.id) }));
    return { placements, unplaced, missing: unplaced.reduce((s, u) => s + u.missing, 0), repeats };
  };

  let best = null;
  for (let i = 0; i < attempts; i += 1) {
    const r = attempt(makeRandom(seed * 1000003 + i * 7919));
    if (!best || r.missing < best.missing || (r.missing === best.missing && r.repeats < best.repeats)) best = r;
    if (best.missing === 0 && best.repeats === 0) break;
  }
  return { placements: best.placements, unplaced: best.unplaced };
};
