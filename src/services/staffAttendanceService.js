import User from '../models/User.js';
import Course from '../models/Course.js';
import CourseTopic from '../models/CourseTopic.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import AcademicCalendar from '../models/AcademicCalendar.js';
import UniversitySettings from '../models/UniversitySettings.js';
import StaffAttendance from '../models/StaffAttendance.js';
import StaffAttendanceRules from '../models/StaffAttendanceRules.js';
import StaffLeave from '../models/StaffLeave.js';
import { teachingCalendar } from './teachingCalendarService.js';
import { syncTopicRelease } from './ragService.js';
import { notifyUsers } from '../utils/notify.js';
import { ROLES, COURSE_STATUS, CLOSED_SEMESTER_STATES, ENROLLMENT_STATUS } from '../config/constants.js';
import { localNow, addDays, weekdayOf, eachDay, toMinutes } from './staffAttendanceRules.js';

// ============================================================================================================
// The teachers' own attendance: working days, automatic absence, approved leave, and moving the course contents
// of a day the teacher could not teach to the next teaching day.
// The pure rules (time window, late flag, campus distance) are in staffAttendanceRules.js.
// ============================================================================================================

export const STAFF_ROLES = [ROLES.TEACHER, ROLES.HOD];
// Calendar entries on which the college itself is closed (examinations are NOT in this list: the teachers still come).
const CLOSED_TYPES = ['holiday', 'summer_vacation', 'winter_vacation', 'semester_break'];
const dayRange = (key) => ({ $gte: new Date(`${key}T00:00:00Z`), $lt: new Date(`${addDays(key, 1)}T00:00:00Z`) });

export const loadClosedEvents = (fromKey, toKey) =>
  AcademicCalendar.find({ type: { $in: CLOSED_TYPES }, startDate: { $lt: new Date(`${addDays(toKey, 1)}T00:00:00Z`) }, endDate: { $gte: new Date(`${fromKey}T00:00:00Z`) } })
    .select('title type startDate endDate department')
    .lean();

// Is this a day on which the person is expected at college? Returns { working, reason }.
export const workingDay = (key, departmentId, settings, events) => {
  const weekly = (settings.calendarRules?.weeklyHolidays || ['sunday']).map((s) => s.toLowerCase());
  const wd = weekdayOf(key);
  if (weekly.includes(wd)) return { working: false, reason: 'Weekly holiday' };
  const ev = events.find((e) => {
    const inDept = !e.department || String(e.department) === String(departmentId);
    return inDept && e.startDate.toISOString().slice(0, 10) <= key && e.endDate.toISOString().slice(0, 10) >= key;
  });
  return ev ? { working: false, reason: ev.title } : { working: true, reason: null };
};

// ---------- moving the contents of a missed day ----------
// Every course content (topic) the teacher had on `dateKey` goes to the next real teaching day of the same class
// (not a Sunday, holiday, examination or vacation). Contents that are already on another day are not touched, so repeating this is harmless.
export const moveTopicsToNextDay = async (userId, dateKey) => {
  const courses = await Course.find({ teacher: userId, status: COURSE_STATUS.ACTIVE }).populate('semester');
  let moved = 0;
  let stuck = 0;
  const details = [];
  for (const course of courses) {
    if (!course.semester || CLOSED_SEMESTER_STATES.includes(course.semester.status)) continue;
    const topics = await CourseTopic.find({ course: course._id, scheduledDate: dayRange(dateKey) });
    if (!topics.length) continue;
    try {
      const cal = await teachingCalendar(course, { from: new Date(`${addDays(dateKey, 1)}T00:00:00Z`) });
      const next = cal.dates[0];
      if (next === undefined) { stuck += topics.length; continue; } // no teaching day left in this semester
      for (const t of topics) {
        t.scheduledDate = new Date(next);
        if (t.availableUntil && t.availableUntil <= t.scheduledDate) t.availableUntil = null;
        await t.save();
        await syncTopicRelease(t).catch(() => {});
        moved += 1;
      }
      details.push({ course: `${course.code} ${course.title}`, topics: topics.length, to: new Date(next).toISOString().slice(0, 10) });
      const students = await CourseEnrollment.find({ course: course._id, status: ENROLLMENT_STATUS.ENROLLED }).distinct('student');
      await notifyUsers([userId, ...students], {
        title: `Class moved: ${course.code}`,
        message: `The content planned for ${dateKey} will be taught on ${new Date(next).toISOString().slice(0, 10)} instead, because the teacher is not available on ${dateKey}.`,
        type: 'schedule',
        link: `/courses/${course._id}`,
      });
    } catch (err) {
      console.error(`Moving topics of ${course.code} failed:`, err.message);
    }
  }
  return { moved, stuck, details };
};

// ---------- automatic absence ----------
// Nobody checked in before the absent time -> absent. An approved leave -> leave. Runs whenever the attendance pages are opened
// (there is no timer on a serverless host), for today (after the absent time) and the days before it (up to a week back).
export const ensureAbsentees = async () => {
  const [rules, settings] = await Promise.all([StaffAttendanceRules.getRules(), UniversitySettings.getSettings()]);
  const now = localNow(new Date(), rules.timezone);
  const from = addDays(now.dateKey, -6);
  const days = eachDay(from, now.dateKey).filter((d) => d < now.dateKey || now.minutes >= toMinutes(rules.absentAfter));
  if (!days.length) return { marked: 0 };

  const [staff, events, existing, leaves] = await Promise.all([
    User.find({ role: { $in: STAFF_ROLES }, isActive: true }).select('_id department createdAt').lean(),
    loadClosedEvents(from, now.dateKey),
    StaffAttendance.find({ date: { $in: days } }).select('user date').lean(),
    StaffLeave.find({ status: 'approved', fromDate: { $lte: now.dateKey }, toDate: { $gte: from } }).lean(),
  ]);
  const have = new Set(existing.map((r) => `${r.user}:${r.date}`));
  const docs = [];
  for (const date of days) {
    for (const u of staff) {
      if (have.has(`${u._id}:${date}`)) continue;
      if (u.createdAt && u.createdAt.toISOString().slice(0, 10) > date) continue; // the account did not exist yet
      if (!workingDay(date, u.department, settings, events).working) continue;
      const leave = leaves.find((l) => String(l.user) === String(u._id) && l.fromDate <= date && l.toDate >= date);
      docs.push({
        user: u._id, department: u.department || null, date, auto: true,
        status: leave ? 'leave' : 'absent', leave: leave?._id || null,
        note: leave ? 'Approved leave' : 'No check-in before the absent time',
      });
    }
  }
  if (!docs.length) return { marked: 0 };
  await StaffAttendance.insertMany(docs, { ordered: false }).catch((err) => { if (err.code !== 11000 && !err.writeErrors) throw err; });

  // The contents of every day a teacher missed move to the next teaching day.
  for (const d of docs) {
    const { moved } = await moveTopicsToNextDay(d.user, d.date);
    if (moved) await StaffAttendance.updateOne({ user: d.user, date: d.date }, { topicsMoved: moved });
    if (d.status === 'absent') {
      await notifyUsers([d.user], { title: 'Marked absent', message: `You were marked absent on ${d.date} because you did not check in before ${rules.absentAfter}. If this is wrong, ask your HOD to correct it.`, type: 'attendance', link: '/staff-attendance' });
    }
  }
  return { marked: docs.length };
};

// ---------- approved leave ----------
// Every working day of an approved leave becomes a "leave" day, and the contents of those days move to the next teaching day.
export const applyApprovedLeave = async (leave) => {
  const settings = await UniversitySettings.getSettings();
  const days = eachDay(leave.fromDate, leave.toDate, 120);
  const events = await loadClosedEvents(leave.fromDate, leave.toDate);
  const existing = await StaffAttendance.find({ user: leave.user, date: { $in: days } }).lean();
  const byDate = new Map(existing.map((r) => [r.date, r]));
  let marked = 0;
  let topicsMoved = 0;
  for (const date of days) {
    if (!workingDay(date, leave.department, settings, events).working) continue;
    const cur = byDate.get(date);
    if (cur && (cur.status === 'present' || cur.status === 'late')) continue; // the person really came
    await StaffAttendance.updateOne(
      { user: leave.user, date },
      { $set: { department: leave.department || null, status: 'leave', leave: leave._id, auto: true, note: 'Approved leave' } },
      { upsert: true }
    );
    marked += 1;
    const { moved } = await moveTopicsToNextDay(leave.user, date);
    topicsMoved += moved;
    if (moved) await StaffAttendance.updateOne({ user: leave.user, date }, { topicsMoved: moved });
  }
  return { marked, topicsMoved };
};

// Who may a reviewer manage? The principal: every teacher and HOD. An HOD: the teachers of their own department.
export const staffScope = (user) => {
  if (user.role === ROLES.UNIVERSITY_HEAD) return { role: { $in: STAFF_ROLES } };
  if (user.role === ROLES.HOD) return { role: ROLES.TEACHER, department: user.department };
  return null;
};

export const canReviewPerson = (reviewer, person) => {
  if (String(reviewer._id) === String(person._id)) return false;
  if (reviewer.role === ROLES.UNIVERSITY_HEAD) return STAFF_ROLES.includes(person.role);
  if (reviewer.role === ROLES.HOD) return person.role === ROLES.TEACHER && String(person.department) === String(reviewer.department);
  return false;
};
