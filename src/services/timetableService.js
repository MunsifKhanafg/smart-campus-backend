import TimetableSlot from '../models/TimetableSlot.js';
import Timetable from '../models/Timetable.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError } from '../utils/apiHelpers.js';
import { notifyUsers } from '../utils/notify.js';
import { CLOSED_SEMESTER_STATES, ENROLLMENT_STATUS, TIMETABLE_STATUS } from '../config/constants.js';

// Rules of thumb used by most universities: 1 credit hour = 1 hour of class per week.
export const CONTACT_MINUTES_PER_CREDIT = 60;
const hm = (min) => `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;

// A course may only be scheduled for as many weekly minutes as its credit hours allow.
// Throws a clear message when the credit hours are already complete, or when the new class would exceed them.
export const assertCreditHoursAvailable = async ({ course, startMinutes, endMinutes, excludeId }) => {
  const limit = (course.creditHours || 0) * CONTACT_MINUTES_PER_CREDIT;
  const filter = { course: course._id };
  if (excludeId) filter._id = { $ne: excludeId };
  const slots = await TimetableSlot.find(filter).select('startMinutes endMinutes').lean();
  const used = slots.reduce((s, x) => s + (x.endMinutes - x.startMinutes), 0);
  const adding = endMinutes - startMinutes;
  if (used >= limit) {
    throw ApiError.conflict(`Credit hours complete. ${course.code} has ${course.creditHours} credit hour(s) (${hm(limit)} per week) and all of it is already on the timetable`);
  }
  if (used + adding > limit) {
    throw ApiError.conflict(`Only ${hm(limit - used)} per week is left for ${course.code} (${course.creditHours} credit hours). This class is ${hm(adding)} long, so please shorten it`);
  }
};

// Finds classes that overlap a time window for the same teacher or the same room.
// Two classes overlap when each one starts before the other ends. Back-to-back classes (10:00-11:00 and 11:00-12:00) are fine.
// Slots of completed/archived semesters are ignored so old timetables never block new ones.
export const findSlotConflicts = async ({ teacher, room, day, startMinutes, endMinutes, excludeId }) => {
  const filter = {
    day,
    startMinutes: { $lt: endMinutes },
    endMinutes: { $gt: startMinutes },
    $or: [{ teacher }, { room: room.trim().toUpperCase() }],
  };
  if (excludeId) filter._id = { $ne: excludeId };

  const candidates = await TimetableSlot.find(filter).populate('semester', 'status').populate('course', 'code').lean();
  const live = candidates.filter((s) => s.semester && !CLOSED_SEMESTER_STATES.includes(s.semester.status));
  return {
    teacher: live.filter((s) => String(s.teacher) === String(teacher)),
    room: live.filter((s) => s.room === room.trim().toUpperCase()),
  };
};

// Throws a 409 with a clear message when the teacher or the room is already busy.
export const assertNoSlotConflicts = async ({ departmentId, ...params }) => {
  const found = await findSlotConflicts(params);
  const { day, room } = params;

  if (found.teacher.length) {
    const s = found.teacher[0];
    throw ApiError.conflict(`This teacher already has ${s.course?.code || 'a class'} on ${day} at ${s.startTime}-${s.endTime}`);
  }
  if (found.room.length) {
    const s = found.room[0];
    // Do not reveal another department's course. Only say the room is taken.
    const sameDept = String(s.department) === String(departmentId);
    throw ApiError.conflict(
      sameDept
        ? `Room ${room.toUpperCase()} is already used by ${s.course?.code} on ${day} at ${s.startTime}-${s.endTime}`
        : `Room ${room.toUpperCase()} is already booked by another department at that time`
    );
  }
};

// The students of one section cannot attend two classes at the same time.
export const assertSectionFree = async ({ semesterId, section, day, startMinutes, endMinutes, excludeId }) => {
  const filter = { semester: semesterId, day, startMinutes: { $lt: endMinutes }, endMinutes: { $gt: startMinutes } };
  if (excludeId) filter._id = { $ne: excludeId };
  const clash = (await TimetableSlot.find(filter).populate('course', 'code section').lean()).find((s) => s.course?.section === section);
  if (clash) throw ApiError.conflict(`Section ${section} already has ${clash.course.code} on ${day} at ${clash.startTime}-${clash.endTime}. The same students cannot attend two classes at once`);
};

// When the HOD gives a course to a different teacher, the course's timetable slots move with it.
// The new teacher must be free at every one of those times. Returns the moved slots (empty if the course is not scheduled).
export const reassignCourseSlots = async (course, newTeacherId) => {
  const slots = await TimetableSlot.find({ course: course._id });
  if (!slots.length) return [];
  if (!newTeacherId) {
    throw ApiError.badRequest('This course is on the timetable. Remove its timetable slots before removing the teacher');
  }

  for (const slot of slots) {
    const found = await findSlotConflicts({
      teacher: newTeacherId,
      room: slot.room,
      day: slot.day,
      startMinutes: slot.startMinutes,
      endMinutes: slot.endMinutes,
      excludeId: slot._id,
    });
    if (found.teacher.length) {
      throw ApiError.conflict(`The new teacher already has a class on ${slot.day} at ${slot.startTime}-${slot.endTime}`);
    }
  }
  await TimetableSlot.updateMany({ course: course._id }, { teacher: newTeacherId });
  return slots;
};

// Tells the students of a course (plus any extra users, e.g. teachers) that the published timetable changed.
// Nothing is sent while the timetable is still a draft, because students cannot see drafts.
export const notifyTimetableChange = async ({ timetableId, courseIds, extraUserIds = [], message }) => {
  const timetable = await Timetable.findById(timetableId).select('status');
  if (!timetable || timetable.status !== TIMETABLE_STATUS.PUBLISHED) return;
  const students = await CourseEnrollment.find({
    course: { $in: courseIds },
    status: ENROLLMENT_STATUS.ENROLLED,
  }).distinct('student');
  await notifyUsers([...students, ...extraUserIds], {
    title: 'Timetable updated',
    message,
    type: 'timetable',
    link: '/timetable',
  });
};
