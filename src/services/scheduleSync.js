import Course from '../models/Course.js';
import CourseTopic from '../models/CourseTopic.js';
import AcademicCalendar from '../models/AcademicCalendar.js';
import TimetableSlot from '../models/TimetableSlot.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import MaterialChunk from '../models/MaterialChunk.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { notifyUsers } from '../utils/notify.js';
import { CLOSED_SEMESTER_STATES, ENROLLMENT_STATUS } from '../config/constants.js';
import { dateKey, fromKey, planTopicDates, DEFAULT_TEACHING_DAYS, DEFAULT_WEEKLY_OFF } from './teachingCalendar.js';

// ============================================================================================
// Puts the dated course contents (CourseTopic) on the REAL teaching days of the academic calendar and keeps them there.
// The date maths is in teachingCalendar.js (pure, unit tested). This file only loads the data around it:
//   - the weekdays the teacher teaches this class (set by the teacher, else read from the timetable, else Monday-Saturday)
//   - the weekly holidays of the university (Settings, Sunday by default)
//   - the calendar entries that apply to the class: university-wide, its department, its semester
//     (holiday, midterm, final, summer / winter vacation, semester break)
//   - the dates of the semester and of the course (the course can never leave the semester)
// ============================================================================================

export const loadWeeklyOff = async () => {
  const s = await UniversitySettings.getSettings();
  return Array.isArray(s.weeklyOffDays) ? s.weeklyOffDays : DEFAULT_WEEKLY_OFF;
};

// Which weekdays does the teacher teach this class on?
export const effectiveTeachingDays = async (course) => {
  if (course.teachingDays?.length) return { days: [...course.teachingDays], source: 'teacher' };
  const slotDays = await TimetableSlot.find({ course: course._id }).distinct('day');
  if (slotDays.length) return { days: slotDays, source: 'timetable' };
  return { days: DEFAULT_TEACHING_DAYS, source: 'default' };
};

// Calendar entries that overlap [from, to] and apply to a department / semester.
export const loadEvents = (department, semesterId, from, to) =>
  AcademicCalendar.find({
    startDate: { $lte: to },
    endDate: { $gte: from },
    $and: [{ $or: [{ department: null }, { department }] }, { $or: [{ semester: null }, { semester: semesterId }] }],
  }).lean();

// The dates a class runs between: its own dates, always cut to the dates of its semester.
export const courseWindow = (course, semester) => {
  const semStart = dateKey(semester.startDate);
  const semEnd = dateKey(semester.endDate);
  let start = course.startDate ? dateKey(course.startDate) : semStart;
  let end = course.endDate ? dateKey(course.endDate) : semEnd;
  if (start < semStart || start > semEnd) start = semStart;
  if (end > semEnd || end < semStart) end = semEnd;
  if (end < start) { start = semStart; end = semEnd; }
  return { start: fromKey(start), end: fromKey(end) };
};

// Plan `count` topics for a class. `from` (optional) moves the first possible day later (for example to today).
export const planCourse = async ({ course, semester, count, from }) => {
  const window = courseWindow(course, semester);
  const start = from && dateKey(from) > dateKey(window.start) ? fromKey(dateKey(from)) : window.start;
  const [{ days, source }, weeklyOff, events] = await Promise.all([
    effectiveTeachingDays(course),
    loadWeeklyOff(),
    loadEvents(course.department, semester._id, start, window.end),
  ]);
  const plan = planTopicDates({ count, start, end: window.end, teachingDays: days, weeklyOff, events });
  return { ...plan, window: { start: dateKey(start), end: dateKey(window.end) }, teachingDays: days, teachingDaysSource: source, weeklyOff };
};

const pushRelease = (topicId, scheduledDate, availableUntil) =>
  MaterialChunk.updateMany({ topic: topicId }, { releaseDate: scheduledDate, availableUntil: availableUntil || null });

// Applies a list of new dates to topics (same order). Returns how many topics actually moved.
export const applyDates = async (topics, dateKeys) => {
  let moved = 0;
  for (let i = 0; i < topics.length; i += 1) {
    const t = topics[i];
    if (dateKey(t.scheduledDate) === dateKeys[i]) continue;
    const next = fromKey(dateKeys[i]);
    const set = { scheduledDate: next };
    if (t.availableUntil && t.availableUntil <= next) set.availableUntil = null; // "available until" must stay after the teaching date
    await CourseTopic.updateOne({ _id: t._id }, { $set: set });
    await pushRelease(t._id, next, set.availableUntil === null ? null : t.availableUntil);
    moved += 1;
  }
  return moved;
};

// Calculates the dates of the topics that were placed by the scheduler and are still ahead (today or later) again.
// Topics that were already taught, and dates typed by the teacher by hand, are never moved.
export const rescheduleCourse = async (course, semester) => {
  const today = fromKey(dateKey(new Date()));
  const topics = await CourseTopic.find({ course: course._id, autoScheduled: true, scheduledDate: { $gte: today } }).sort({ scheduledDate: 1, order: 1, createdAt: 1 });
  if (!topics.length) return { moved: 0 };

  const plan = await planCourse({ course, semester, count: topics.length, from: today });
  if (!plan.dates.length) return { moved: 0, noTeachingDays: true };

  const moved = await applyDates(topics, plan.dates);
  if (moved) {
    const students = await CourseEnrollment.find({ course: course._id, status: ENROLLMENT_STATUS.ENROLLED }).distinct('student');
    await notifyUsers([course.teacher, ...students].filter(Boolean), {
      title: 'Course content dates updated',
      message: `The teaching dates of ${course.code} ${course.title} were recalculated because the academic calendar or the semester dates changed (${moved} topic${moved === 1 ? '' : 's'} moved).`,
      type: 'timetable',
      link: `/courses/${course._id}`,
    });
  }
  return { moved };
};

const reschedule = async (courses) => {
  let moved = 0;
  for (const course of courses) {
    const semester = course.semester;
    if (!semester || CLOSED_SEMESTER_STATES.includes(semester.status)) continue;
    try {
      moved += (await rescheduleCourse(course, semester)).moved;
    } catch (err) {
      console.error(`Rescheduling ${course.code} failed:`, err.message);
    }
  }
  return moved;
};

// The calendar changed (holiday, exam, vacation ... added, moved or removed) or the weekly holidays changed.
// scope: { semester } = a semester-only entry, { department } = a department entry, {} = the whole university.
export const syncScope = async ({ department, semester } = {}) => {
  const filter = { autoScheduled: true };
  if (semester) filter.semester = semester;
  else if (department) filter.department = department;
  const courseIds = await CourseTopic.find(filter).distinct('course');
  if (!courseIds.length) return 0;
  const courses = await Course.find({ _id: { $in: courseIds }, status: 'active' }).populate('semester');
  return reschedule(courses);
};

// The dates of a semester changed. First every class that followed the old semester dates follows the new ones and no class
// is left outside the semester; then the dated course contents are calculated again on the new teaching days.
export const syncSemesterSchedule = async (semester, oldDates) => {
  const courses = await Course.find({ semester: semester._id });
  const semStart = dateKey(semester.startDate);
  const semEnd = dateKey(semester.endDate);
  for (const c of courses) {
    let start = c.startDate ? dateKey(c.startDate) : semStart;
    let end = c.endDate ? dateKey(c.endDate) : semEnd;
    if (oldDates && c.startDate && start === dateKey(oldDates.startDate)) start = semStart; // followed the semester start
    if (oldDates && c.endDate && end === dateKey(oldDates.endDate)) end = semEnd; // followed the semester end
    if (start < semStart || start > semEnd) start = semStart;
    if (end > semEnd || end < semStart) end = semEnd;
    if (end <= start) { start = semStart; end = semEnd; }
    if (!c.startDate || !c.endDate || start !== dateKey(c.startDate) || end !== dateKey(c.endDate)) {
      await Course.updateOne({ _id: c._id }, { startDate: fromKey(start), endDate: fromKey(end) });
    }
  }
  const fresh = await Course.find({ semester: semester._id, status: 'active' }).populate('semester');
  return reschedule(fresh);
};
