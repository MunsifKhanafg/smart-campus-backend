import AcademicCalendar from '../models/AcademicCalendar.js';
import Examination from '../models/Examination.js';
import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import CourseTopic from '../models/CourseTopic.js';
import TimetableSlot from '../models/TimetableSlot.js';
import Quiz from '../models/Quiz.js';
import Assignment from '../models/Assignment.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError } from '../utils/apiHelpers.js';
import { notifyUsers } from '../utils/notify.js';
import { syncTopicRelease, removeChunksForTopic } from './ragService.js';
import { planTopicDays, seededRandom, MIN_PER_CLASS, MAX_PER_CLASS } from './topicPlanner.js';
import { DAYS, COURSE_STATUS } from '../config/constants.js';

// ==========================================================================================================
// The ACADEMIC CALENDAR decides which days a class can really be taught. Course content is spread over those days only,
// never over all calendar days.
//
//   a day is a TEACHING DAY of a class when
//     - it lies inside the semester (and inside the course's own start / end dates, if set), and
//     - its weekday is one the teacher really teaches (the teacher's own choice, else the timetable, else every working day), and
//     - it is NOT a weekly holiday (Sunday by default, configurable in Settings), a public holiday, a midterm or final
//       examination period (calendar events AND examination sessions), a summer or winter vacation, or a semester break.
//
// Topics placed by the scheduler (autoScheduled) are recalculated automatically whenever the calendar, an examination or the
// semester dates change. Topics the teacher dates by hand are "pinned" and never moved. Days in the past are never touched.
// ==========================================================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const dayMs = (d) => {
  const x = new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
};
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekdayOf = (ms) => WEEKDAY_NAMES[new Date(ms).getUTCDay()];
const todayMs = () => dayMs(new Date());
const idOf = (v) => v?._id || v;

// Calendar events that stop teaching.
export const NON_TEACHING = {
  holiday: 'Holiday',
  midterm_exam: 'Midterm examinations',
  final_exam: 'Final examinations',
  summer_vacation: 'Summer vacation',
  winter_vacation: 'Winter vacation',
  semester_break: 'Semester break',
};

// Every non-teaching day of a semester -> the reason. (day in ms -> text)
export const blockedDays = async (semester, settings) => {
  const from = dayMs(semester.startDate);
  const to = dayMs(semester.endDate);
  const blocked = new Map();
  const mark = (s, e, reason) => {
    for (let t = Math.max(dayMs(s), from); t <= Math.min(dayMs(e), to); t += DAY_MS) if (!blocked.has(t)) blocked.set(t, reason);
  };

  const [events, exams] = await Promise.all([
    AcademicCalendar.find({
      type: { $in: Object.keys(NON_TEACHING) },
      startDate: { $lte: semester.endDate },
      endDate: { $gte: semester.startDate },
      $and: [
        { $or: [{ department: null }, { department: idOf(semester.department) }] },
        { $or: [{ semester: null }, { semester: semester._id }] },
      ],
    }).lean(),
    Examination.find({ semester: semester._id }).select('name startDate endDate').lean(),
  ]);
  events.forEach((e) => mark(e.startDate, e.endDate, e.title || NON_TEACHING[e.type]));
  exams.forEach((x) => mark(x.startDate, x.endDate, `Examination: ${x.name}`));

  const weekly = new Set((settings.calendarRules?.weeklyHolidays || ['sunday']).map((s) => s.toLowerCase()));
  for (let t = from; t <= to; t += DAY_MS) if (weekly.has(weekdayOf(t)) && !blocked.has(t)) blocked.set(t, 'Weekly holiday');
  return blocked;
};

// Quizzes and presentations of ONE class with the day they fall on. A topic is never planned on these days.
//   scheduled quiz -> the day it starts, surprise quiz -> the day the teacher started it, presentation -> its date (the deadline)
export const assessmentDays = async (course) => {
  const [quizzes, presentations] = await Promise.all([
    Quiz.find({ course: course._id, $or: [{ type: 'scheduled', startTime: { $ne: null } }, { type: 'surprise', startedAt: { $ne: null } }] }).select('title type startTime startedAt').lean(),
    Assignment.find({ course: course._id, type: 'presentation' }).select('title deadline').lean(),
  ]);
  const rows = [];
  quizzes.forEach((q) => { const d = q.type === 'scheduled' ? q.startTime : q.startedAt; if (d) rows.push({ ms: dayMs(d), kind: 'quiz', title: q.title }); });
  presentations.forEach((p) => { if (p.deadline) rows.push({ ms: dayMs(p.deadline), kind: 'presentation', title: p.title }); });
  return rows
    .sort((a, b) => a.ms - b.ms)
    .map((r) => ({ date: isoDay(r.ms), ms: r.ms, kind: r.kind, title: r.title, reason: `${r.kind === 'quiz' ? 'Quiz' : 'Presentation'}: ${r.title}` }));
};

const addAssessmentDays = async (course, blocked, from, to) => {
  for (const a of await assessmentDays(course)) if (a.ms >= from && a.ms <= to && !blocked.has(a.ms)) blocked.set(a.ms, a.reason);
};

// The weekdays this class is taught on, and where that information comes from.
export const courseWeekdays = async (course, settings) => {
  if (course.teachingDays?.length) return { days: DAYS.filter((d) => course.teachingDays.includes(d)), source: 'teacher' };
  const days = await TimetableSlot.find({ course: course._id }).distinct('day');
  if (days.length) return { days: DAYS.filter((d) => days.includes(d)), source: 'timetable' };
  const weekly = new Set((settings.calendarRules?.weeklyHolidays || ['sunday']).map((s) => s.toLowerCase()));
  return { days: DAYS.filter((d) => !weekly.has(d)), source: 'default' };
};

// All the teaching days of a class. `from` limits the list to today and later (used when scheduling or recalculating).
export const teachingCalendar = async (course, { from } = {}) => {
  const settings = await UniversitySettings.getSettings();
  const semester = course.semester?.startDate ? course.semester : await Semester.findById(idOf(course.semester));
  if (!semester) throw ApiError.notFound('The semester of this class was not found');

  const blocked = await blockedDays(semester, settings);
  await addAssessmentDays(course, blocked, dayMs(semester.startDate), dayMs(semester.endDate));
  const { days, source } = await courseWeekdays(course, settings);
  const wanted = new Set(days);
  const semFrom = dayMs(semester.startDate);
  const semTo = dayMs(semester.endDate);
  // A class never runs outside its semester, even if the course dates were typed wider.
  const rangeFrom = Math.max(semFrom, course.startDate ? dayMs(course.startDate) : semFrom);
  const rangeTo = Math.min(semTo, course.endDate ? dayMs(course.endDate) : semTo);
  const startAt = from ? Math.max(rangeFrom, dayMs(from)) : rangeFrom;

  const dates = [];
  const skipped = [];
  for (let t = startAt; t <= rangeTo; t += DAY_MS) {
    if (!wanted.has(weekdayOf(t))) continue;
    if (blocked.has(t)) skipped.push({ ms: t, reason: blocked.get(t) });
    else dates.push(t);
  }
  return { semester, weekdays: days, source, range: { from: rangeFrom, to: rangeTo }, dates, skipped, blocked };
};

// Consecutive skipped days with the same reason become one period ("Winter vacation: 22 Dec to 5 Jan").
const groupSkipped = (skipped) => {
  const out = [];
  for (const s of skipped) {
    const last = out[out.length - 1];
    if (last && last.reason === s.reason && s.ms - last.toMs <= 7 * DAY_MS) { last.toMs = s.ms; last.days += 1; }
    else out.push({ reason: s.reason, fromMs: s.ms, toMs: s.ms, days: 1 });
  }
  return out.map((p) => ({ reason: p.reason, from: isoDay(p.fromMs), to: isoDay(p.toMs), days: p.days }));
};

// What the teacher sees on the Topics tab.
export const calendarSummary = async (course) => {
  const all = await teachingCalendar(course);
  const left = await teachingCalendar(course, { from: new Date(todayMs()) });

  // The state of the plan: how the topics are spread, and whether the whole course still fits inside the semester.
  const topics = await CourseTopic.find({ course: course._id }).select('scheduledDate').lean();
  const today = todayMs();
  const perDay = new Map();
  let last = null;
  for (const t of topics) {
    const ms = dayMs(t.scheduledDate);
    if (last === null || ms > last) last = ms;
    if (ms >= today) perDay.set(ms, (perDay.get(ms) || 0) + 1);
  }
  const loads = [...perDay.values()];
  const upcoming = loads.reduce((a, b) => a + b, 0);
  const plan = {
    total: topics.length,
    upcoming,
    past: topics.length - upcoming,
    classDays: perDay.size,
    minPerClass: loads.length ? Math.min(...loads) : 0,
    maxPerClass: loads.length ? Math.max(...loads) : 0,
    targetPerClass: { min: MIN_PER_CLASS, max: MAX_PER_CLASS },
    lastTopicDate: last === null ? null : isoDay(last),
    withinSemester: last === null || last <= all.range.to,
    capacity: left.dates.length * MAX_PER_CLASS, // topics that fit at 3 per class on the days that are left
    overCapacity: upcoming > left.dates.length * MAX_PER_CLASS,
  };

  return {
    plan,
    assessmentDays: (await assessmentDays(course)).map(({ date, kind, title }) => ({ date, kind, title })),
    semester: { name: all.semester.name, startDate: isoDay(dayMs(all.semester.startDate)), endDate: isoDay(dayMs(all.semester.endDate)) },
    range: { from: isoDay(all.range.from), to: isoDay(all.range.to) },
    weekdays: all.weekdays,
    source: all.source, // teacher | timetable | default
    teachingDaysTotal: all.dates.length,
    teachingDaysLeft: left.dates.length,
    nextTeachingDays: left.dates.slice(0, 5).map(isoDay),
    skippedPeriods: groupSkipped(left.skipped),
  };
};

// Spreads `count` topics evenly over the teaching days. count <= days: every topic gets its own day, evenly spaced.
// count > days: several topics share a day. Returns the day (ms) of every topic, in order.
export const distribute = (count, dates) => {
  if (!count || !dates.length) return [];
  return Array.from({ length: count }, (_, i) => dates[Math.min(dates.length - 1, Math.floor((i * dates.length) / count))]);
};

// A manual date must be a real teaching day: inside the semester and not a holiday, examination, vacation or weekly holiday.
export const assertTeachingDate = async (course, date) => {
  const cal = await teachingCalendar(course);
  const t = dayMs(date);
  if (t < cal.range.from || t > cal.range.to) {
    throw ApiError.badRequest(`${isoDay(t)} is outside the dates of this class (${isoDay(cal.range.from)} to ${isoDay(cal.range.to)})`);
  }
  if (cal.blocked.has(t)) throw ApiError.badRequest(`${isoDay(t)} is not a teaching day: ${cal.blocked.get(t)}. Please choose another date`);
};

// Saves the new dates of a list of topics (new or existing). Every class day gets 2 to 3 topics (see topicPlanner.js).
// regenerate = true: a different arrangement from the current one (different class days and 2/3 pattern).
// Returns { moved: how many existing topics changed their day, plan }.
const place = async (topics, days, { regenerate = false } = {}) => {
  const before = topics.map((t) => (t.isNew ? null : dayMs(t.scheduledDate)));
  let plan = planTopicDays(topics.length, days);
  if (regenerate) {
    // A few tries, in case a random plan happens to be the one the teacher already has.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      plan = planTopicDays(topics.length, days, { rng: seededRandom(Math.floor(Math.random() * 2 ** 31)) });
      if (plan.slots.some((s, i) => s !== before[i])) break;
    }
  }
  const slots = plan.slots;
  let moved = 0;
  for (let i = 0; i < topics.length; i += 1) {
    const t = topics[i];
    const wasNew = t.isNew;
    const changed = wasNew || dayMs(t.scheduledDate) !== slots[i];
    t.scheduledDate = new Date(slots[i]);
    t.autoScheduled = true;
    t.sequence = t.sequence || i + 1;
    if (!changed) continue;
    await t.save();
    if (!wasNew) {
      moved += 1;
      await syncTopicRelease(t).catch(() => {}); // the AI assistant follows the release date
    }
  }
  return { moved, plan };
};

const upcomingAuto = (courseId) =>
  CourseTopic.find({ course: courseId, autoScheduled: true, scheduledDate: { $gte: new Date(todayMs()) } }).sort({ sequence: 1, scheduledDate: 1 });

// The teacher presses "schedule": the new titles (if any) and every not-yet-taught scheduler topic of the course are spread
// evenly over the teaching days that are left.
export const scheduleCourseTopics = async (course, { titles = [], userId = null, regenerate = false, replace = false } = {}) => {
  const cal = await teachingCalendar(course, { from: new Date(todayMs()) });
  if (!cal.dates.length) {
    throw ApiError.badRequest(
      `There are no teaching days left for this class between today and ${isoDay(cal.range.to)}. ` +
        'Check the teaching days of the class, the semester dates and the holidays or examinations in the academic calendar'
    );
  }
  // replace: every topic that is still ahead and has no uploaded files is removed first (this includes the old big topics made before
  // the contents were split), so the small topics of the contents take their place. Taught topics and topics with files stay untouched.
  if (replace) {
    if (!titles.length) throw ApiError.badRequest('There are no course contents to build the new plan from');
    const old = await CourseTopic.find({ course: course._id, scheduledDate: { $gte: new Date(todayMs()) }, 'materials.0': { $exists: false } }).select('_id');
    for (const t of old) await removeChunksForTopic(t._id).catch(() => {});
    await CourseTopic.deleteMany({ _id: { $in: old.map((t) => t._id) } });
  }
  const existing = await upcomingAuto(course._id);
  if (!existing.length && !titles.length) {
    throw ApiError.badRequest(regenerate ? 'There is no plan to regenerate yet. Create the topics from the course contents first' : 'There are no topics to schedule');
  }

  const last = await CourseTopic.findOne({ course: course._id }).sort({ sequence: -1 }).select('sequence').lean();
  let seq = last?.sequence || 0;
  const fresh = titles.map(
    (title) =>
      new CourseTopic({
        course: course._id,
        department: idOf(course.department),
        semester: cal.semester._id,
        title,
        description: '',
        scheduledDate: new Date(cal.dates[0]),
        autoScheduled: true,
        sequence: (seq += 1),
        createdBy: userId,
      })
  );
  const all = [...existing, ...fresh];
  const { moved, plan } = await place(all, cal.dates, { regenerate });
  const dates = all.map((t) => dayMs(t.scheduledDate));
  return {
    scheduled: all.length,
    created: fresh.length,
    moved,
    regenerated: regenerate,
    teachingDays: cal.dates.length,
    classes: plan.classes,
    perClass: { min: plan.minPerClass, max: plan.maxPerClass },
    spareDays: plan.spareDays,
    overCapacity: plan.overCapacity, // true = more than 3 topics per class were needed to finish inside the semester
    first: isoDay(Math.min(...dates)),
    last: isoDay(Math.max(...dates)),
    skippedPeriods: groupSkipped(cal.skipped),
  };
};

// "Regenerate Schedule": the teacher is not happy with the plan, so every topic that is still ahead is arranged again.
// Topics already taught (past dates) and dates the teacher typed by hand are never touched.
export const regenerateCourseSchedule = (course, userId = null) => scheduleCourseTopics(course, { userId, regenerate: true });

// Recalculates ONE course after the calendar, an exam or the semester dates changed. The teacher is told what moved.
export const recalcCourse = async (courseId, reason = '') => {
  const course = await Course.findById(courseId).populate('semester');
  if (!course || course.status !== COURSE_STATUS.ACTIVE) return 0;
  const topics = await upcomingAuto(course._id);
  if (!topics.length) return 0;

  const cal = await teachingCalendar(course, { from: new Date(todayMs()) });
  if (!cal.dates.length) {
    if (course.teacher) {
      await notifyUsers([course.teacher], {
        title: `No teaching days left: ${course.code}`,
        message: 'After the latest calendar change there is no teaching day left for the remaining topics. Please check the semester dates and the holidays.',
        type: 'schedule',
        link: `/courses/${course._id}`,
      });
    }
    return 0;
  }
  const { moved } = await place(topics, cal.dates);
  if (moved > 0 && course.teacher) {
    await notifyUsers([course.teacher], {
      title: `Course schedule updated: ${course.code}`,
      message: `${moved} topic date(s) were recalculated ${reason || 'because the academic calendar, an examination or the semester dates changed'}. Topics only fall on real teaching days.`,
      type: 'schedule',
      link: `/courses/${course._id}`,
    });
  }
  return moved;
};

// A quiz or a presentation was added, moved or removed: the topics of that class that are still ahead are arranged again,
// so no topic stays on a quiz or presentation day. Never throws (the quiz or assignment itself is already saved). Returns how many moved.
export const rearrangeForAssessment = async (courseId, what) => {
  try {
    return await recalcCourse(courseId, `because of ${what}: no topic is planned on a quiz or presentation day`);
  } catch (e) {
    console.error('Schedule rearrangement failed:', e.message);
    return 0;
  }
};

export const recalcSemester = async (semesterId) => {
  const courseIds = await CourseTopic.distinct('course', { semester: semesterId, autoScheduled: true, scheduledDate: { $gte: new Date(todayMs()) } });
  let moved = 0;
  for (const id of courseIds) moved += await recalcCourse(id);
  return moved;
};

// Several calendar changes in a row (for example a whole list of holidays) are handled once.
const timers = new Map();
const queue = (semesterId) => {
  const key = String(semesterId);
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    recalcSemester(semesterId).catch((e) => console.error('Schedule recalculation failed:', e.message));
  }, 800));
};

export const recalcForCalendarEvent = async (event) => {
  const filter = { autoScheduled: true, scheduledDate: { $gte: new Date(todayMs()) } };
  if (event.semester) filter.semester = event.semester;
  else if (event.department) filter.department = event.department;
  (await CourseTopic.distinct('semester', filter)).forEach(queue);
};

export const recalcForExam = async (exam) => { queue(exam.semester); };
