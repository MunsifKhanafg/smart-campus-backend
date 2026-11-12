// Default academic calendar for ONE academic year (Fall + Spring), for two kinds of region. Pure functions (no database), unit tested.
//   hot  : long SUMMER vacation (12 weeks), short winter vacation (2 weeks)   - for example the plains: Punjab, Sindh
//   cold : long WINTER vacation (10 weeks), short summer vacation (4 weeks)   - for example the mountains: Murree, Swat, Gilgit
// Each semester is 18 weeks: 16 weeks of teaching (the midterm week is one of them) + 2 weeks of final examinations.
// A semester starts on a Monday, vacations are whole weeks, so the next semester also starts on a Monday.
// The head / HOD can change every event afterwards. Islamic holidays (Eid ...) move with the moon, so they are NOT added: add them by hand.
const DAY = 24 * 60 * 60 * 1000;
export const SEMESTER_WEEKS = 18;
export const TEACHING_WEEKS = 16;

const add = (d, n) => new Date(d.getTime() + n * DAY);
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
export const key = (d) => d.toISOString().slice(0, 10);
// First Monday of a month (month: 0 = January)
export const firstMonday = (year, month) => { const d = utc(year, month, 1); return add(d, (8 - d.getUTCDay()) % 7); };

export const CLIMATES = {
  hot: { label: 'Hot area', fallMonth: 8, winterWeeks: 2, summerWeeks: 12, note: 'Long summer vacation (12 weeks), short winter vacation (2 weeks)' },
  cold: { label: 'Cold area', fallMonth: 7, winterWeeks: 10, summerWeeks: 4, note: 'Long winter vacation (10 weeks), short summer vacation (4 weeks)' },
};

// Fixed-date national holidays (month index, day, title)
const HOLIDAYS = [[1, 5, 'Kashmir Solidarity Day'], [2, 23, 'Pakistan Day'], [4, 1, 'Labour Day'], [7, 14, 'Independence Day'], [10, 9, 'Iqbal Day'], [11, 25, 'Quaid-e-Azam Day']];

export const buildDefaultCalendar = ({ climate, year, holidays = true }) => {
  const c = CLIMATES[climate];
  if (!c) throw new Error('Choose a hot area or a cold area calendar');
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Choose a valid year');
  const events = [];
  const push = (type, title, startDate, endDate = startDate, description = '') => events.push({ type, title, startDate, endDate, description, source: 'default' });

  const first = firstMonday(year, c.fallMonth);
  let start = first;
  ['Fall', 'Spring'].forEach((term, i) => {
    const label = `${term} ${i === 0 ? year : year + 1}`;
    const finalStart = add(start, TEACHING_WEEKS * 7);
    const finalEnd = add(start, SEMESTER_WEEKS * 7 - 1);
    push('semester_start', `${label} semester starts`, start);
    push('midterm_exam', `${label} midterm examinations`, add(start, 8 * 7), add(start, 8 * 7 + 5), 'Teaching stops for this week');
    push('final_exam', `${label} final examinations`, finalStart, finalEnd, 'Teaching stops');
    push('semester_end', `${label} semester ends`, finalEnd);
    const weeks = i === 0 ? c.winterWeeks : c.summerWeeks;
    const vacStart = add(finalEnd, 1);
    const vacEnd = add(vacStart, weeks * 7 - 1);
    push(i === 0 ? 'winter_vacation' : 'summer_vacation', `${i === 0 ? 'Winter' : 'Summer'} vacation (${weeks} weeks)`, vacStart, vacEnd);
    start = add(vacEnd, 1);
  });

  if (holidays) {
    const off = events.filter((e) => ['winter_vacation', 'summer_vacation', 'final_exam'].includes(e.type));
    for (const y of [year, year + 1]) {
      for (const [m, d, title] of HOLIDAYS) {
        const day = utc(y, m, d);
        if (day < first || day >= start) continue; // outside this academic year
        if (off.some((e) => day >= e.startDate && day <= e.endDate)) continue; // already a day off
        push('holiday', title, day);
      }
    }
  }
  events.sort((a, b) => a.startDate - b.startDate || a.endDate - b.endDate);
  return { events, nextFallStart: start, climate: c.label, note: c.note };
};
