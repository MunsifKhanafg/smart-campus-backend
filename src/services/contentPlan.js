// Divides the numbered contents of a course over the days on which the teacher really has class.
// Pure functions (no database), so the rules can be tested.
//   class days = the weekdays of the course on the timetable, between the start and the end of the course,
//                without holidays, vacations and examination weeks of the academic calendar.

const DAY = 86400000;
const NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const toUtc = (v) => {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  return Date.parse(`${s}T00:00:00Z`);
};
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// Returns { dates: [{ date: 'YYYY-MM-DD', weekday }], skipped: [{ date, weekday, label }] }.
// skipped = class days that fall inside a blocked range (holiday, vacation, exams), so the teacher can see why they are missing.
export const classDates = ({ start, end, weekdays, blocked = [] }) => {
  const days = new Set(weekdays);
  const ranges = blocked.map((b) => ({ from: toUtc(b.from), to: toUtc(b.to), label: b.label || 'Not a teaching day' }));
  const dates = [];
  const skipped = [];
  for (let t = toUtc(start); t <= toUtc(end); t += DAY) {
    const weekday = NAMES[new Date(t).getUTCDay()];
    if (!days.has(weekday)) continue;
    const hit = ranges.find((r) => t >= r.from && t <= r.to);
    if (hit) skipped.push({ date: ymd(t), weekday, label: hit.label });
    else dates.push({ date: ymd(t), weekday });
  }
  return { dates, skipped };
};

// "1. Intro\n- Variables\n• Loops" -> ['Intro', 'Variables', 'Loops']  (the numbers and bullets are removed, the order is kept)
export const contentItems = (text) => {
  let lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/^\s*(?:\d+\s*[.)]|[-*•–])\s*/, '').trim()).filter(Boolean);
  if (lines.length === 1 && lines[0].includes(';')) lines = lines[0].split(';').map((s) => s.trim()).filter(Boolean);
  return lines;
};

// Spreads the items over the class days in order.
//   more days than items -> every item gets a block of days (it starts on its first day, the other days "continue" it)
//   more items than days -> several items are taught on one day
// Returns [{ date, weekday, items: [{ no, text }], continues: { no, text } | null }]
export const planByDates = (items, dates) => {
  const N = items.length;
  const M = dates.length;
  if (!N || !M) return [];
  const startOf = items.map((_, i) => Math.floor((i * M) / N));
  const plan = dates.map((d) => ({ ...d, items: [], continues: null }));
  items.forEach((text, i) => plan[startOf[i]].items.push({ no: i + 1, text }));
  let last = null;
  for (const day of plan) {
    if (day.items.length) last = day.items[day.items.length - 1];
    else if (last) day.continues = last;
  }
  return plan;
};
