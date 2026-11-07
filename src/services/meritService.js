import Application from '../models/Application.js';
import Department from '../models/Department.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError } from '../utils/apiHelpers.js';
import { APPLICATION_STATUS as ST, rankByDepartment } from './applicationService.js';
import { meritReadiness, interviewMessage, formatDay } from './meritRules.js';
import { sendMail, mailConfigured } from './mailService.js';

// ============================================================================================
// Merit list and interview calls.
//   - Nothing is ranked or shown while applications are open.
//   - Publishing (on the merit list date) ranks every eligible applicant inside their department, freezes the rank,
//     calls the top `meritSeats` of each department for an interview, and gives each of them the interview message.
//     The message is shown on their "Track my application" page and, when SMTP is configured, sent by e-mail.
//   - Applicants whose documents are still missing (needs_info) or who were rejected are not ranked.
//   - Applicants with the same score share a rank, so everyone tied at the last seat is called too.
// ============================================================================================

let running = false; // one publisher at a time in this server process

const plan = async (settings) => {
  const p = settings.admissionPortal || {};
  const apps = await Application.find({ intake: p.intakeName || '', status: { $nin: [ST.REJECTED, ST.NEEDS_INFO] } })
    .select('applicationNumber name email department status meritScore createdAt')
    .lean();
  const ranked = rankByDepartment(apps);
  const depts = await Department.find({ _id: { $in: [...new Set(apps.map((a) => String(a.department)))] } }).select('name').lean();
  return { ranked, deptName: new Map(depts.map((d) => [String(d._id), d.name])), seats: p.meritSeats || 0 };
};

// What the University Head sees in Settings: is it ready, what is missing, and who would be called.
export const meritPreview = async () => {
  const settings = await UniversitySettings.getSettings();
  const p = settings.admissionPortal || {};
  const { ready, problems, portal } = meritReadiness(settings);
  const { ranked, deptName, seats } = await plan(settings);

  const byDept = new Map();
  for (const r of ranked) {
    const key = String(r.department);
    const row = byDept.get(key) || { department: deptName.get(key) || 'Department', applicants: 0, called: 0 };
    row.applicants += 1;
    if (r.rank <= seats) row.called += 1;
    byDept.set(key, row);
  }
  return {
    published: !!p.meritListPublished,
    publishedAt: p.meritListPublishedAt || null,
    visibleToPublic: portal.meritListPublished,
    ready,
    problems: p.meritListPublished ? [] : problems.filter((x) => !/already been published/.test(x)),
    meritListDate: p.meritListDate || null,
    autoPublish: p.meritAutoPublish !== false,
    seats,
    departments: [...byDept.values()].sort((a, b) => a.department.localeCompare(b.department)),
    calledTotal: [...byDept.values()].reduce((n, d) => n + d.called, 0),
    emailConfigured: mailConfigured(),
  };
};

export const publishMeritList = async () => {
  if (running) throw ApiError.conflict('The merit list is being published right now');
  running = true;
  try {
    const now = new Date();
    const settings = await UniversitySettings.getSettings();
    const { ready, problems } = meritReadiness(settings, now);
    if (!ready) throw ApiError.conflict(problems.join(' '));

    const p = settings.admissionPortal;
    const { ranked, deptName, seats } = await plan(settings);
    const interview = { date: p.interview.date, time: p.interview.time || '', venue: p.interview.venue || '', instructions: p.interview.instructions || '' };

    const calledList = [];
    const ops = ranked.map((r) => {
      const called = r.rank <= seats;
      const set = { 'merit.rank': r.rank, 'merit.called': called };
      const update = { $set: set };
      if (called) {
        const message = interviewMessage({
          name: r.name,
          applicationNumber: r.applicationNumber,
          department: deptName.get(String(r.department)) || 'your department',
          intake: p.intakeName,
          rank: r.rank,
          interview,
        });
        Object.assign(set, {
          'merit.interviewDate': interview.date,
          'merit.interviewTime': interview.time,
          'merit.venue': interview.venue,
          'merit.message': message,
          'merit.notifiedAt': now,
          remarks: message.slice(0, 1000), // shown to the applicant on the tracking page
        });
        update.$push = { history: { status: r.status, note: `Called for interview on ${formatDay(interview.date)}`, by: 'Admissions office', at: now } };
        calledList.push({ id: r._id, email: r.email, message, department: deptName.get(String(r.department)) || 'your department' });
      }
      return { updateOne: { filter: { _id: r._id }, update } };
    });
    if (ops.length) await Application.bulkWrite(ops);

    // The list becomes public only now, after every rank is written.
    await UniversitySettings.updateOne({ key: 'global' }, { $set: { 'admissionPortal.meritListPublished': true, 'admissionPortal.meritListPublishedAt': now } });

    // E-mail (optional). One failed address never stops the others.
    let emailed = 0;
    let failed = 0;
    let emailNote = '';
    if (!mailConfigured()) {
      emailNote = 'E-mail is not set up on the server (SMTP_HOST and SMTP_FROM). The interview message is shown on each applicant\'s "Track my application" page.';
    } else {
      const statuses = [];
      for (let i = 0; i < calledList.length; i += 5) {
        await Promise.all(calledList.slice(i, i + 5).map(async (c) => {
          const res = await sendMail({ to: c.email, subject: `Interview call: ${c.department}${p.intakeName ? ` (${p.intakeName})` : ''}`, text: c.message });
          if (res.ok) emailed += 1; else { failed += 1; if (res.reason === 'nodemailer_missing') emailNote = 'The "nodemailer" package is not installed on the server. Run: npm install nodemailer'; }
          statuses.push({ updateOne: { filter: { _id: c.id }, update: { $set: { 'merit.emailStatus': res.ok ? 'sent' : 'failed' } } } });
        }));
      }
      if (statuses.length) await Application.bulkWrite(statuses);
    }

    return { applicants: ranked.length, called: calledList.length, emailed, emailFailed: failed, emailNote, publishedAt: now };
  } finally {
    running = false;
  }
};

// Run once a minute by the server. Publishes by itself on the merit list date, but only when the University Head set a
// date and left "publish automatically" on. Without a date, publishing is always done by hand.
export const autoPublishMerit = async () => {
  const settings = await UniversitySettings.getSettings();
  const p = settings.admissionPortal || {};
  if (p.meritListPublished || p.meritAutoPublish === false || !p.meritListDate) return null;
  if (!meritReadiness(settings).ready) return null;
  const result = await publishMeritList();
  console.log(`Merit list published automatically: ${result.called} applicants called for interview`);
  return result;
};

// Undo a publish (for example one made while testing). E-mails that were already sent cannot be taken back.
export const resetMeritList = async () => {
  await UniversitySettings.updateOne({ key: 'global' }, { $set: { 'admissionPortal.meritListPublished': false, 'admissionPortal.meritListPublishedAt': null } });
  // The interview text was copied into "remarks"; remove it again where it is still unchanged.
  await Application.updateMany({ 'merit.called': true }, [
    { $set: { remarks: { $cond: [{ $eq: ['$remarks', { $substrCP: ['$merit.message', 0, 1000] }] }, '', '$remarks'] } } },
  ]);
  const res = await Application.updateMany(
    { 'merit.rank': { $ne: null } },
    { $set: { 'merit.rank': null, 'merit.called': false, 'merit.interviewDate': null, 'merit.interviewTime': '', 'merit.venue': '', 'merit.message': '', 'merit.notifiedAt': null, 'merit.emailStatus': 'none' } }
  );
  return { applicants: res.modifiedCount };
};
