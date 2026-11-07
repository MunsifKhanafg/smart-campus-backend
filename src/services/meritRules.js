import { portalState } from './applicationService.js';

// Rules of the merit list that need no database, so they can be unit tested.

const DAY = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' };
// Dates from the settings form are whole days stored at UTC midnight, so they are always shown in UTC.
export const formatDay = (d) => (d ? new Date(d).toLocaleDateString('en-GB', DAY) : '');

// Can the merit list be published right now? Returns every reason why not, so the University Head sees what is missing.
export const meritReadiness = (settings, now = new Date()) => {
  const p = settings?.admissionPortal || {};
  const portal = portalState(settings, now);
  const problems = [];

  if (p.meritListPublished) problems.push('The merit list has already been published.');
  if (portal.status === 'open' || portal.status === 'upcoming') {
    problems.push(`Applications are not over yet${portal.deadline ? ` (they close on ${formatDay(portal.deadline)})` : ''}. The merit list is never published while people can still apply.`);
  }
  if (p.meritListDate && new Date(now).getTime() < new Date(p.meritListDate).getTime()) {
    problems.push(`The merit list date is ${formatDay(p.meritListDate)}. It cannot be published before that day.`);
  }
  if (!(p.meritSeats > 0)) problems.push('Enter how many applicants of each department are called for an interview (seats per department).');
  if (!p.interview?.date) problems.push('Enter the interview date.');

  return { ready: problems.length === 0, problems, portal };
};

// The message a called applicant receives (tracking page and email).
export const interviewMessage = ({ name, applicationNumber, department, intake, rank, interview }) => {
  const when = [formatDay(interview.date), interview.time, interview.venue].filter(Boolean).join(', ');
  const lines = [
    `Dear ${name},`,
    `Congratulations! You are number ${rank} in the merit list of ${department}${intake ? ` (${intake})` : ''} and you are called for an interview.`,
    `Interview: ${when}.`,
  ];
  if (interview.instructions) lines.push(interview.instructions);
  lines.push(`Your application number is ${applicationNumber}. Please bring it with your original documents.`);
  return lines.join('\n');
};
