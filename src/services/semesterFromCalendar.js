import { computeEndDate, DEFAULT_SEMESTER_WEEKS } from './semesterDates.js';

// Semester dates from the ACADEMIC CALENDAR (pure functions, unit tested). Events of the whole university and of the HOD's own
// department count; events of another department never do.
const DAY = 24 * 60 * 60 * 1000;
const day = (d) => new Date(`${new Date(d).toISOString().slice(0, 10)}T00:00:00.000Z`);
const scope = (events, departmentId) => events.filter((e) => !e.department || String(e.department) === String(departmentId));
const byStart = (a, b) => day(a.startDate) - day(b.startDate);

// Where does the semester that begins on `start` end? The calendar's own "semester ends" entry, otherwise the end of the final
// examinations, otherwise null (the caller then uses the duration in weeks). Entries that belong to the NEXT semester are ignored.
export const endFromCalendar = ({ events, start, departmentId = null }) => {
  const list = scope(events, departmentId);
  const s = day(start);
  const next = list.filter((e) => e.type === 'semester_start' && day(e.startDate) > s).sort(byStart)[0];
  const limit = next ? day(next.startDate) : null;
  const pick = (type) => list.filter((e) => e.type === type && day(e.startDate) >= s && (!limit || day(e.startDate) < limit)).sort(byStart)[0];
  const end = pick('semester_end');
  if (end) return { endDate: day(end.endDate), source: 'the semester end in the academic calendar' };
  const finals = pick('final_exam');
  if (finals) return { endDate: day(finals.endDate), source: 'the final examinations in the academic calendar' };
  return null;
};

// The next semester the calendar announces (a semester that started up to `graceDays` ago still counts, so a late HOD is not locked out).
// Returns null when the calendar has no semester start yet.
export const suggestSemesterDates = ({ events, today = new Date(), departmentId = null, weeks = DEFAULT_SEMESTER_WEEKS, graceDays = 21 }) => {
  const from = new Date(day(today).getTime() - graceDays * DAY);
  const s = scope(events, departmentId).filter((e) => e.type === 'semester_start' && day(e.startDate) >= from).sort(byStart)[0];
  if (!s) return null;
  const startDate = day(s.startDate);
  const end = endFromCalendar({ events, start: startDate, departmentId });
  return {
    startDate,
    endDate: end?.endDate || computeEndDate(startDate, weeks),
    source: end?.source || `${weeks} weeks after the start`,
    title: s.title,
    fromCalendar: !!end,
  };
};
