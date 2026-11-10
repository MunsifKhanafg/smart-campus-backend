import { asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { getCourseFor } from '../services/accessService.js';
import { calendarSummary, scheduleCourseTopics, recalcCourse } from '../services/teachingCalendarService.js';
import { DAYS } from '../config/constants.js';

// The teaching days of one class: weekdays, semester range, and what the academic calendar removes (holidays, exams, vacations).
export const courseCalendar = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'any');
  sendSuccess(res, await calendarSummary(course));
});

// The teacher chooses the weekdays this class is really taught. Empty = follow the timetable. The topics the scheduler placed
// are moved onto the new days.
export const setTeachingDays = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'write');
  course.teachingDays = DAYS.filter((d) => req.body.days.includes(d));
  await course.save();
  const moved = await recalcCourse(course._id);
  logAudit(req, 'course.teaching_days', 'Course', course._id, { days: course.teachingDays, moved });
  sendSuccess(res, { ...(await calendarSummary(course)), moved }, moved ? `Teaching days saved. ${moved} topic date(s) were recalculated` : 'Teaching days saved');
});

// "Schedule on teaching days": new titles (from the course contents) and every topic that was not taught yet are spread evenly
// over the real teaching days that are left. Holidays, examinations and vacations never receive a topic.
export const autoSchedule = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'write');
  const result = await scheduleCourseTopics(course, { titles: req.body.titles || [], userId: req.user._id });
  logAudit(req, 'topic.auto_schedule', 'Course', course._id, { scheduled: result.scheduled, created: result.created });
  sendSuccess(
    res,
    result,
    `${result.scheduled} topic(s) placed on ${result.teachingDays} teaching day(s), from ${result.first} to ${result.last}`,
    result.created ? 201 : 200
  );
});
