// ==========================================================================================================
// Semester dates. The END date follows from the START date and the DURATION in weeks:
//   end = start + (weeks x 7) - 1 day    (a semester of 18 weeks that starts on Monday 1 Sep ends on Sunday 4 Jan)
// It is calculated again whenever the start date or the duration changes. An administrator can still type an end date
// by hand (then endDateManual is true), until the start date or the duration changes again.
// ==========================================================================================================

export const DEFAULT_SEMESTER_WEEKS = 18;
const DAY_MS = 24 * 60 * 60 * 1000;

export const computeEndDate = (start, weeks = DEFAULT_SEMESTER_WEEKS) => {
  const s = new Date(start);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) + (weeks * 7 - 1) * DAY_MS);
};
