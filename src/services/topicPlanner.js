// ============================================================================================
// Smart semester course planner: the pure rules (no database), so they are easy to unit test.
//
//   1. planTopicDays   - gives every class day 2 to 3 numbered topics, in order, and spreads the class days over the
//                        teaching days that are left. Every topic always gets a day inside the semester.
//   2. carryForward    - a teacher is absent or on leave: the topics of that day move to the next available teaching day and
//                        the topics behind them shift only as far as needed (a day never gets more than 3 topics unless
//                        the semester has no room left).
//
// `days` are any sortable day values (the service passes UTC day numbers in milliseconds).
// ============================================================================================

export const MIN_PER_CLASS = 2;
export const MAX_PER_CLASS = 3;

// Small seeded random generator (mulberry32). The same seed always gives the same plan, which keeps the tests stable.
export const seededRandom = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// A stable number out of a text (for example a course id), so one course always gets the same default plan.
export const hashSeed = (text) => {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};

const pick = (rng, n) => Math.floor(rng() * n);

// How many class days can a plan use? Fewest = 3 topics every class, most = 2 topics every class.
export const classCountRange = (count, min = MIN_PER_CLASS, max = MAX_PER_CLASS) => {
  const lo = Math.max(1, Math.ceil(count / max));
  const hi = Math.max(lo, Math.floor(count / min));
  return { lo, hi };
};

// Divides `count` numbered topics over `days` (the teaching days that are left, in date order).
//   without rng : fixed plan. As many class days as possible (mostly 2 topics, some 3), evenly spaced. Used for the first plan
//                 and for the automatic recalculation after a holiday, so a calendar change never shuffles the whole semester.
//   with rng    : a different plan every time (used by "Regenerate Schedule"): a different number of class days, different
//                 days, different 2/3 pattern. The rules stay the same.
// If the semester has fewer teaching days than 3 topics per class needs, every topic is STILL placed (so the course is finished
// inside the semester), but some classes carry more than 3 topics and `overCapacity` is true.
// Returns { slots: [day of topic 1, day of topic 2, ...], classes, minPerClass, maxPerClass, spareDays, overCapacity }
export const planTopicDays = (count, days, { rng = null, min = MIN_PER_CLASS, max = MAX_PER_CLASS } = {}) => {
  const D = days.length;
  if (!count || !D) return { slots: [], classes: 0, minPerClass: 0, maxPerClass: 0, spareDays: D, overCapacity: false };

  const { lo, hi } = classCountRange(count, min, max);
  let k;
  let overCapacity = false;
  if (D < lo) {
    k = D;
    overCapacity = true;
  } else {
    const top = Math.min(D, hi);
    if (rng) {
      const from = Math.min(top, Math.ceil((lo + top) / 2));
      k = from + pick(rng, top - from + 1);
    } else k = top;
  }

  // sizes: count = base * k + extra, so every class has `base` or `base + 1` topics
  const base = Math.floor(count / k);
  const extra = count - base * k;
  const bigger = new Set();
  if (rng) {
    const order = Array.from({ length: k }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) { const j = pick(rng, i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    order.slice(0, extra).forEach((i) => bigger.add(i));
  } else {
    for (let i = 0; i < k; i += 1) if (Math.floor(((i + 1) * extra) / k) > Math.floor((i * extra) / k)) bigger.add(i);
  }
  const sizes = Array.from({ length: k }, (_, i) => base + (bigger.has(i) ? 1 : 0));

  // class days: one per bucket of teaching days, so the classes are spread over the whole semester and stay in date order
  const slots = [];
  for (let i = 0; i < k; i += 1) {
    const from = Math.floor((i * D) / k);
    const to = Math.max(from, Math.floor(((i + 1) * D) / k) - 1);
    const idx = rng ? from + pick(rng, to - from + 1) : from;
    for (let n = 0; n < sizes[i]; n += 1) slots.push(days[idx]);
  }
  return { slots, classes: k, minPerClass: Math.min(...sizes), maxPerClass: Math.max(...sizes), spareDays: D - k, overCapacity };
};

// A teacher missed a day. `moved` (the topics of that day, in order) go to the first day of `days`; if that day is full
// (more than `max`), its last topics move on to the next day, and so on. Nothing is ever dropped.
//   days  : the teaching days after the missed day on which the teacher is available, in date order
//   load  : Map(day -> [{ id, fixed }]) the topics already on those days (fixed = a date typed by the teacher, never pushed away)
//   moved : [{ id }] the topics of the missed day
// Returns { placed: Map(day -> [{ id, fixed }]), stuck: [ids], overCapacity }
//   stuck = there is no teaching day left at all, so the topics could not move
//   overCapacity = the last day of the semester had to take more than `max` topics
export const carryForward = ({ days, load = new Map(), moved = [], max = MAX_PER_CLASS }) => {
  const placed = new Map(days.map((d) => [d, (load.get(d) || []).map((x) => ({ ...x }))]));
  if (!days.length) return { placed, stuck: moved.map((m) => m.id), overCapacity: false };

  let carry = moved.map((m) => ({ id: m.id, fixed: false }));
  let overCapacity = false;
  days.forEach((day, i) => {
    const list = [...carry, ...placed.get(day)];
    carry = [];
    if (i < days.length - 1) {
      for (let j = list.length - 1; j >= 0 && list.length > max; j -= 1) {
        if (!list[j].fixed) carry.unshift(...list.splice(j, 1));
      }
    } else if (list.length > max) overCapacity = true; // no room behind the last day: keep them here, the course still finishes
    placed.set(day, list);
  });
  return { placed, stuck: [], overCapacity };
};
