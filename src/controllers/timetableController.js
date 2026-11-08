import Timetable from '../models/Timetable.js';
import TimetableSlot, { toMinutes } from '../models/TimetableSlot.js';
import Course from '../models/Course.js';
import Semester from '../models/Semester.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { assertNoSlotConflicts, assertCreditHoursAvailable, assertSectionFree, notifyTimetableChange } from '../services/timetableService.js';
import { makePeriods, buildSchedule, hhmm } from '../services/timetableGenerator.js';
import {
  ROLES,
  COURSE_STATUS,
  CLOSED_SEMESTER_STATES,
  ENROLLMENT_STATUS,
  TIMETABLE_STATUS,
  DAYS,
} from '../config/constants.js';

const populateSlot = (q) =>
  q
    .populate('course', 'code title section creditHours')
    .populate('teacher', 'name')
    .populate('semester', 'name academicYear status');

const sortSlots = (slots) =>
  slots.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.startMinutes - b.startMinutes);

const loadSemester = async (id) => {
  const semester = await Semester.findById(id);
  if (!semester) throw ApiError.notFound('Semester not found');
  return semester;
};

const assertSemesterOpen = (semester) => {
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) {
    throw ApiError.badRequest(`The semester is ${semester.status}. Its timetable can no longer be changed`);
  }
};

const getOrCreateTimetable = (semester) =>
  Timetable.findOneAndUpdate(
    { semester: semester._id },
    { $setOnInsert: { department: semester.department, status: TIMETABLE_STATUS.DRAFT } },
    { upsert: true, new: true }
  );

const bump = (timetableId) => Timetable.updateOne({ _id: timetableId }, { $inc: { version: 1 } });

const fmt = (s) => `${s.day} ${s.startTime}-${s.endTime} in ${s.room}`;

// HOD (own department) and Head (any): the full timetable of one semester, draft or published.
export const getSemesterTimetable = asyncHandler(async (req, res) => {
  const semester = await loadSemester(req.params.semesterId);
  assertDepartmentAccess(req.user, semester.department);

  const timetable = await Timetable.findOne({ semester: semester._id });
  const slots = timetable ? await populateSlot(TimetableSlot.find({ timetable: timetable._id })).lean() : [];
  sendSuccess(res, {
    timetable: timetable || { status: TIMETABLE_STATUS.DRAFT, version: 0, semester: semester._id },
    slots: sortSlots(slots),
  });
});

export const createSlot = asyncHandler(async (req, res) => {
  const { course: courseId, room, day, startTime, endTime } = req.body;

  const course = await Course.findById(courseId).populate('semester');
  if (!course) throw ApiError.notFound('Course not found');
  assertDepartmentAccess(req.user, course.department);
  if (course.status !== COURSE_STATUS.ACTIVE) throw ApiError.badRequest('Only active courses can be scheduled');
  assertSemesterOpen(course.semester);
  if (!course.teacher) throw ApiError.badRequest('Assign a teacher to this course before scheduling it');

  const startMinutes = toMinutes(startTime);
  const endMinutes = toMinutes(endTime);
  if (endMinutes <= startMinutes) throw ApiError.badRequest('End time must be after the start time');
  // 1) credit hours of this course, 2) teacher / room clashes (the teacher is checked across ALL semesters and departments)
  await assertCreditHoursAvailable({ course, startMinutes, endMinutes });
  await assertSectionFree({ semesterId: course.semester._id, section: course.section, day, startMinutes, endMinutes });
  await assertNoSlotConflicts({
    departmentId: course.department,
    teacher: course.teacher,
    room,
    day,
    startMinutes,
    endMinutes,
  });

  const timetable = await getOrCreateTimetable(course.semester);
  const slot = await TimetableSlot.create({
    timetable: timetable._id,
    department: course.department,
    semester: course.semester._id,
    course: course._id,
    teacher: course.teacher,
    room,
    day,
    startTime,
    endTime,
  });
  await bump(timetable._id);

  logAudit(req, 'timetable.slot_create', 'TimetableSlot', slot._id, { course: course.code, day, startTime, endTime });
  await notifyTimetableChange({
    timetableId: timetable._id,
    courseIds: [course._id],
    extraUserIds: [course.teacher],
    message: `${course.code} was added: ${fmt(slot)}`,
  });
  sendSuccess(res, await populateSlot(TimetableSlot.findById(slot._id)), 'Class added to timetable', 201);
});

export const updateSlot = asyncHandler(async (req, res) => {
  const slot = await TimetableSlot.findById(req.params.id).populate('semester', 'status department');
  if (!slot) throw ApiError.notFound('Timetable slot not found');
  assertDepartmentAccess(req.user, slot.department);
  assertSemesterOpen(slot.semester);

  const next = {
    room: req.body.room ?? slot.room,
    day: req.body.day ?? slot.day,
    startTime: req.body.startTime ?? slot.startTime,
    endTime: req.body.endTime ?? slot.endTime,
  };
  const startMinutes = toMinutes(next.startTime);
  const endMinutes = toMinutes(next.endTime);
  if (endMinutes <= startMinutes) throw ApiError.badRequest('End time must be after the start time');

  const slotCourse = await Course.findById(slot.course).select('code creditHours section');
  if (slotCourse) {
    await assertCreditHoursAvailable({ course: slotCourse, startMinutes, endMinutes, excludeId: slot._id });
    await assertSectionFree({ semesterId: slot.semester._id, section: slotCourse.section, day: next.day, startMinutes, endMinutes, excludeId: slot._id });
  }
  await assertNoSlotConflicts({
    departmentId: slot.department,
    teacher: slot.teacher,
    room: next.room,
    day: next.day,
    startMinutes,
    endMinutes,
    excludeId: slot._id,
  });

  slot.set(next);
  await slot.save(); // the model recalculates startMinutes / endMinutes
  await bump(slot.timetable);

  logAudit(req, 'timetable.slot_update', 'TimetableSlot', slot._id, next);
  const course = await Course.findById(slot.course).select('code');
  await notifyTimetableChange({
    timetableId: slot.timetable,
    courseIds: [slot.course],
    extraUserIds: [slot.teacher],
    message: `${course?.code || 'A class'} moved to ${fmt(slot)}`,
  });
  sendSuccess(res, await populateSlot(TimetableSlot.findById(slot._id)), 'Class updated');
});

export const deleteSlot = asyncHandler(async (req, res) => {
  const slot = await TimetableSlot.findById(req.params.id).populate('semester', 'status');
  if (!slot) throw ApiError.notFound('Timetable slot not found');
  assertDepartmentAccess(req.user, slot.department);
  assertSemesterOpen(slot.semester);

  const course = await Course.findById(slot.course).select('code');
  await slot.deleteOne();
  await bump(slot.timetable);

  logAudit(req, 'timetable.slot_delete', 'TimetableSlot', slot._id, { course: course?.code });
  await notifyTimetableChange({
    timetableId: slot.timetable,
    courseIds: [slot.course],
    extraUserIds: [slot.teacher],
    message: `${course?.code || 'A class'} on ${fmt(slot)} was removed`,
  });
  sendSuccess(res, null, 'Class removed from timetable');
});

// Publishing makes the timetable the official schedule that students and teachers see.
export const publishTimetable = asyncHandler(async (req, res) => {
  const semester = await loadSemester(req.params.semesterId);
  assertDepartmentAccess(req.user, semester.department);
  assertSemesterOpen(semester);

  const timetable = await Timetable.findOne({ semester: semester._id });
  const slotCount = timetable ? await TimetableSlot.countDocuments({ timetable: timetable._id }) : 0;
  if (!timetable || !slotCount) throw ApiError.badRequest('Add at least one class before publishing');

  timetable.status = TIMETABLE_STATUS.PUBLISHED;
  timetable.publishedAt = new Date();
  timetable.publishedBy = req.user._id;
  timetable.version += 1;
  await timetable.save();

  const [students, teachers] = await Promise.all([
    CourseEnrollment.find({ semester: semester._id, status: ENROLLMENT_STATUS.ENROLLED }).distinct('student'),
    TimetableSlot.find({ timetable: timetable._id }).distinct('teacher'),
  ]);
  await notifyUsers([...students, ...teachers], {
    title: 'Timetable published',
    message: `The official timetable for ${semester.name} is now available`,
    type: 'timetable',
    link: '/my-timetable',
  });

  logAudit(req, 'timetable.publish', 'Timetable', timetable._id, { semester: semester.name });
  sendSuccess(res, timetable, 'Timetable published');
});

export const unpublishTimetable = asyncHandler(async (req, res) => {
  const semester = await loadSemester(req.params.semesterId);
  assertDepartmentAccess(req.user, semester.department);
  assertSemesterOpen(semester);

  const timetable = await Timetable.findOne({ semester: semester._id });
  if (!timetable) throw ApiError.notFound('Timetable not found');
  timetable.status = TIMETABLE_STATUS.DRAFT;
  await timetable.save();

  logAudit(req, 'timetable.unpublish', 'Timetable', timetable._id);
  sendSuccess(res, timetable, 'Timetable moved back to draft. Students no longer see it');
});

// Builds the whole timetable of a semester automatically (see services/timetableGenerator.js for the rules).
// The result is always a DRAFT: the HOD looks at it, changes any class by hand, and only then publishes it.
export const generateTimetable = asyncHandler(async (req, res) => {
  const semester = await loadSemester(req.params.semesterId);
  assertDepartmentAccess(req.user, semester.department);
  assertSemesterOpen(semester);

  const cfg = req.body;
  const periods = makePeriods(toMinutes(cfg.startTime), toMinutes(cfg.endTime), cfg.slotMinutes);
  if (!periods.length) throw ApiError.badRequest('No period fits between the start and the end time');
  const rooms = [...new Set(cfg.rooms.map((r) => r.trim().toUpperCase()).filter(Boolean))];

  const courses = await Course.find({ semester: semester._id, status: COURSE_STATUS.ACTIVE }).populate('teacher', 'name').lean();
  if (!courses.length) throw ApiError.badRequest('This semester has no active courses yet. Offer the subjects and assign teachers first');
  const noTeacher = courses.filter((c) => !c.teacher).map((c) => c.code);

  const timetable = await getOrCreateTimetable(semester);
  if (cfg.mode === 'replace') await TimetableSlot.deleteMany({ timetable: timetable._id });

  // Hours of every course that are already on this timetable (only matters in "fill" mode).
  const own = await TimetableSlot.find({ timetable: timetable._id }).select('course startMinutes endMinutes').lean();
  const ownMinutes = new Map();
  own.forEach((s) => ownMinutes.set(String(s.course), (ownMinutes.get(String(s.course)) || 0) + s.endMinutes - s.startMinutes));

  // Everything already on a live timetable keeps its teacher, room and section busy.
  const live = (await TimetableSlot.find({ day: { $in: cfg.days } }).populate('semester', 'status').populate('course', 'section').lean())
    .filter((x) => x.semester && !CLOSED_SEMESTER_STATES.includes(x.semester.status));
  const existing = live.map((s) => ({
    teacher: String(s.teacher), room: s.room, day: s.day, startMinutes: s.startMinutes, endMinutes: s.endMinutes,
    group: String(s.semester._id) === String(semester._id) ? `${semester._id}|${s.course?.section}` : null,
  }));

  const lessons = courses
    .filter((c) => c.teacher)
    .map((c) => ({
      id: String(c._id), code: c.code, teacher: String(c.teacher._id), group: `${semester._id}|${c.section}`,
      sessions: Math.max(0, (c.creditHours || 0) - Math.round((ownMinutes.get(String(c._id)) || 0) / 60)),
    }))
    .filter((l) => l.sessions > 0);

  const { placements, unplaced } = buildSchedule({ classes: lessons, days: cfg.days, periods, rooms, existing, seed: cfg.seed ?? Date.now() % 100000 });
  if (placements.length) {
    await TimetableSlot.insertMany(placements.map((p) => ({
      timetable: timetable._id, department: semester.department, semester: semester._id, course: p.classId,
      teacher: lessons.find((l) => l.id === p.classId).teacher,
      room: p.room, day: p.day, startTime: hhmm(p.start), endTime: hhmm(p.end), startMinutes: p.start, endMinutes: p.end,
    })));
  }
  await Timetable.updateOne({ _id: timetable._id }, { status: TIMETABLE_STATUS.DRAFT, $inc: { version: 1 } });

  const codeOf = new Map(lessons.map((l) => [l.id, l.code]));
  const reason = 'No period was free: the teacher, the section or every room is already busy in all periods. Add rooms or days, or give the course to another teacher.';
  logAudit(req, 'timetable.generate', 'Timetable', timetable._id, { semester: semester.name, mode: cfg.mode, placed: placements.length, unplaced: unplaced.length });
  sendSuccess(res, {
    placed: placements.length,
    periodsPerDay: periods.length,
    unplaced: unplaced.map((u) => ({ code: codeOf.get(u.classId), missing: u.missing, reason })),
    noTeacher,
  }, unplaced.length ? `${placements.length} classes placed, ${unplaced.length} course(s) could not be completed` : `Timetable created with ${placements.length} classes. Check it, change anything you like, then publish`);
});

// Student or teacher: their own classes from PUBLISHED timetables only.
export const myTimetable = asyncHandler(async (req, res) => {
  const publishedIds = await Timetable.find({ status: TIMETABLE_STATUS.PUBLISHED }).distinct('_id');
  const filter = { timetable: { $in: publishedIds } };

  if (req.user.role === ROLES.STUDENT) {
    filter.course = {
      $in: await CourseEnrollment.find({ student: req.user._id, status: ENROLLMENT_STATUS.ENROLLED }).distinct('course'),
    };
  } else {
    filter.teacher = req.user._id;
  }

  const slots = await populateSlot(TimetableSlot.find(filter)).lean();
  const open = slots.filter((s) => s.semester && !CLOSED_SEMESTER_STATES.includes(s.semester.status));
  sendSuccess(res, sortSlots(open));
});
