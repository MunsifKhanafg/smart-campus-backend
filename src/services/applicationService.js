import Counter from '../models/Counter.js';

// New-student admission portal: the rules that do not need the database, so they can be unit tested.

// Used when the University Head has not typed a list of their own in Settings.
export const DEFAULT_DOCUMENTS = ['CNIC or B-Form', 'Matric certificate', 'Intermediate certificate', 'Passport-size photo'];

export const APPLICATION_STATUS = {
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  NEEDS_INFO: 'needs_info',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
};

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; // 1 June 2026

// Is the portal accepting applications right now? Dates are whole days (UTC). The closing day itself still counts.
//   off      = the switch is off
//   upcoming = the switch is on but the opening date has not come yet
//   closed   = the closing day has passed
//   open     = accepting applications
export const portalState = (settings, nowInput = new Date()) => {
  const now = new Date(nowInput); // a Date or a timestamp
  const p = settings?.admissionPortal || {};
  const start = p.startDate ? new Date(p.startDate) : null;
  const deadline = p.deadline ? new Date(p.deadline) : null;
  const meritDate = p.meritListDate ? new Date(p.meritListDate) : null;

  let status = 'open';
  let closedReason = '';
  if (!p.open) {
    status = 'off';
    closedReason = 'Admissions are not open at the moment';
  } else if (start && now < start) {
    status = 'upcoming';
    closedReason = `Applications open on ${longDate(start)}`;
  } else if (deadline && now.getTime() >= deadline.getTime() + DAY) {
    status = 'closed';
    closedReason = `Applications closed on ${longDate(deadline)}`;
  }

  // The merit list is NEVER public while people can still apply. It becomes visible only when ALL of these are true:
  // it was published (by the publish step, not by a checkbox), applications are over, and the merit list date has come.
  const applicationsOver = status === 'closed' || status === 'off';
  const meritDateReached = !meritDate || new Date(now).getTime() >= meritDate.getTime();

  return {
    open: status === 'open',
    status,
    closedReason,
    intakeName: p.intakeName || '',
    startDate: start,
    deadline,
    meritListDate: meritDate,
    instructions: p.instructions || '',
    externalUrl: p.externalUrl || '',
    meritListPublished: !!p.meritListPublished && applicationsOver && meritDateReached,
    requiredDocuments: p.requiredDocuments?.length ? [...p.requiredDocuments] : [...DEFAULT_DOCUMENTS],
  };
};

const pct = (marks, total) => (Number.isFinite(marks) && Number.isFinite(total) && total > 0 ? Math.min(100, (marks / total) * 100) : null);

// Merit score out of 100.
//   with an entry test:    matric 20%, intermediate 50%, entry test 30%
//   without an entry test: matric 30%, intermediate 70%
// Computed only on the server, so an applicant cannot choose their own score.
export const computeMerit = ({ matricMarks, matricTotal, interMarks, interTotal, testMarks, testTotal }) => {
  const m = pct(matricMarks, matricTotal);
  const i = pct(interMarks, interTotal);
  if (m === null || i === null) return 0;
  const t = pct(testMarks, testTotal);
  const score = t === null ? m * 0.3 + i * 0.7 : m * 0.2 + i * 0.5 + t * 0.3;
  return Math.round(score * 100) / 100;
};

// APP-2026-00042. The counter is atomic, so two people applying at the same time never get the same number.
export const nextApplicationNumber = async (now = new Date()) => {
  const year = now.getUTCFullYear();
  const seq = await Counter.next(`application-${year}`);
  return `APP-${year}-${String(seq).padStart(5, '0')}`;
};

// Same list under the name the older tests and screens use.
export const DEFAULT_REQUIRED_DOCUMENTS = DEFAULT_DOCUMENTS;

// marks / total as a percentage rounded to two decimals. Form values arrive as text, so strings are accepted.
export const calcPercentage = (marks, total) => {
  const m = Number(marks);
  const t = Number(total);
  if (!Number.isFinite(m) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.round((m / t) * 10000) / 100;
};

// Simple merit order by the education percentage. Every department + programme + intake has its own list that starts at
// rank 1. Equal percentages are ranked by who applied first, so the order is never random. Returns Map(applicationId -> rank).
export const rankApplications = (applications) => {
  const groups = new Map();
  for (const a of applications) {
    const k = `${a.department}|${a.program}|${a.intake}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const ranks = new Map();
  for (const list of groups.values()) {
    list.sort((a, b) => (b.education?.percentage || 0) - (a.education?.percentage || 0) || new Date(a.createdAt) - new Date(b.createdAt));
    list.forEach((a, i) => ranks.set(a._id, i + 1));
  }
  return ranks;
};

// Ranks rows inside each department by merit score (highest first). Equal scores share a rank.
export const rankByDepartment = (rows, deptKey = (r) => String(r.department)) => {
  const groups = new Map();
  for (const r of rows) (groups.get(deptKey(r)) || groups.set(deptKey(r), []).get(deptKey(r))).push(r);
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.meritScore - a.meritScore || new Date(a.createdAt) - new Date(b.createdAt));
    let rank = 0;
    let prev = null;
    list.forEach((r, idx) => {
      if (prev === null || r.meritScore !== prev) rank = idx + 1;
      prev = r.meritScore;
      out.push({ ...r, rank });
    });
  }
  return out;
};
