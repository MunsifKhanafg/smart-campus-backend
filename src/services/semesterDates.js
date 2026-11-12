// When an HOD creates a semester, its start and end dates come from the academic calendar:
// odd semesters (1, 3, 5, 7) belong to the FIRST term of the academic year (Fall), even semesters (2, 4, 6, 8) to the SECOND (Spring).
// An event of the HOD's own department wins over a university-wide event.
// Pure function, no database. Dates are "YYYY-MM-DD" text.

const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

// A semester lasts 18 weeks by default: 16 weeks of teaching (the midterm week is one of them) + 2 weeks of final examinations.
// The same number is used by the default academic calendar (services/calendarTemplates.js).
export const DEFAULT_SEMESTER_WEEKS = 18;

// End date = start date + N weeks - 1 day (the last day of week N). Returns a Date at UTC midnight, or null for invalid input.
// Used when the semester end date is calculated from the start date and the duration (and again whenever either one changes).
export const computeEndDate = (start, weeks = DEFAULT_SEMESTER_WEEKS) => {
  const n = Number(weeks);
  if (!start || !Number.isFinite(n) || n < 1) return null;
  const s = new Date(`${day(start)}T00:00:00.000Z`);
  if (Number.isNaN(s.getTime())) return null;
  return new Date(s.getTime() + (Math.round(n) * 7 - 1) * 24 * 60 * 60 * 1000);
};

// "2026-2027" or "2026" -> 2026
export const startYearOf = (academicYear) => {
  const m = String(academicYear || '').match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
};

// events: [{ type, title, startDate, endDate, department }]  (department = id or null for the whole university)
export const pickSemesterDates = ({ events, number, startYear, departmentId }) => {
  const from = `${startYear}-07-01`;
  const to = `${startYear + 1}-08-31`;
  const inYear = events
    .filter((e) => ['semester_start', 'semester_end'].includes(e.type))
    .map((e) => ({ ...e, s: day(e.startDate), e: day(e.endDate), own: e.department && String(e.department) === String(departmentId) }))
    .filter((e) => e.s >= from && e.s <= to);

  // The department's own semester events (if it has any) replace the university ones.
  const own = inYear.filter((e) => e.own);
  const pool = own.length ? own : inYear.filter((e) => !e.department);
  const source = own.length ? 'department' : 'university';

  const starts = pool.filter((e) => e.type === 'semester_start').sort((a, b) => a.s.localeCompare(b.s));
  const ends = pool.filter((e) => e.type === 'semester_end').sort((a, b) => a.e.localeCompare(b.e));
  const term = number % 2 === 1 ? 0 : 1;
  const start = starts[term];
  if (!start) return { found: false, reason: `The academic calendar of ${startYear}-${startYear + 1} has no "${term === 0 ? 'first' : 'second'} semester starts" event yet.` };

  const nextStart = starts[term + 1];
  const end = ends.find((e) => e.e >= start.s && (!nextStart || e.e < nextStart.s));
  return {
    found: true, source,
    startDate: start.s, startTitle: start.title,
    endDate: end ? end.e : null, endTitle: end ? end.title : null,
  };
};
