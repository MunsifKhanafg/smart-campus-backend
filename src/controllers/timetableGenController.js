import Course from '../models/Course.js';
import Semester from '../models/Semester.js';
import Department from '../models/Department.js';
import Timetable from '../models/Timetable.js';
import TimetableSlot from '../models/TimetableSlot.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { buildSchedule, makePeriods, hhmm, toMin } from '../services/timetableGenerator.js';
import { COURSE_STATUS, CLOSED_SEMESTER_STATES, ENROLLMENT_STATUS, TIMETABLE_STATUS, DAYS } from '../config/constants.js';

const PERIOD = 60; // one class = one hour
const groupOf = (semesterId, section) => `${semesterId}|${section || 'A'}`; // the students of one semester and section
const live = (slot) => slot.semester && !CLOSED_SEMESTER_STATES.includes(slot.semester.status);

// Works out the arrangement. Nothing is saved here. The HOD's department only; closed semesters are never touched.
//  * every ACTIVE course that has a teacher gets as many one-hour classes per week as it has credit hours
//  * teachers and rooms that are already busy in other semesters (any department) are avoided
//  * courses without a teacher are skipped and listed, so the HOD knows what is missing
const plan = async (user, b) => {
  const departmentId = user.department;
  const dept = await Department.findById(departmentId).select('code name').lean();

  const filter = { department: departmentId, status: { $nin: CLOSED_SEMESTER_STATES } };
  if (b.semesters) filter._id = { $in: b.semesters };
  const semesters = await Semester.find(filter).sort({ number: 1 }).lean();
  if (b.semesters && semesters.length !== new Set(b.semesters).size) {
    throw ApiError.badRequest('Some selected semesters were not found, are closed, or belong to another department');
  }
  if (!semesters.length) throw ApiError.badRequest('There is no open semester to schedule');
  const semIds = semesters.map((s) => s._id);
  const semName = new Map(semesters.map((s) => [String(s._id), s.name]));

  const courses = await Course.find({ semester: { $in: semIds }, status: COURSE_STATUS.ACTIVE }).populate('teacher', 'name').sort({ code: 1 }).lean();
  const noTeacher = courses.filter((c) => !c.teacher);
  const ready = courses.filter((c) => c.teacher);
  if (!ready.length) throw ApiError.badRequest('No course has a teacher yet. Assign teachers to the courses first');

  const periods = makePeriods(toMin(b.startTime), toMin(b.endTime), PERIOD);
  if (!periods.length) throw ApiError.badRequest('The class hours are too short for one class');

  // Rooms: the ones the HOD typed, otherwise one room per semester group plus a spare, named after the department.
  const groups = new Set(ready.map((c) => groupOf(c.semester, c.section)));
  const rooms = (b.rooms?.length ? b.rooms : Array.from({ length: Math.max(3, groups.size + 1) }, (_, i) => `${dept?.code || 'R'}-R${i + 1}`))
    .map((r) => r.trim().toUpperCase());
  const uniqueRooms = [...new Set(rooms)];
  const teacherIds = [...new Set(ready.map((c) => String(c.teacher._id)))];

  const [mine, others] = await Promise.all([
    TimetableSlot.find({ semester: { $in: semIds } }).populate('course', 'section').lean(),
    TimetableSlot.find({ semester: { $nin: semIds }, $or: [{ teacher: { $in: teacherIds } }, { room: { $in: uniqueRooms } }] }).populate('semester', 'status').lean(),
  ]);

  // Classes of other semesters (also other departments) are fixed: avoid their teachers and rooms.
  const existing = others.filter(live).map((s) => ({
    teacher: String(s.teacher), room: s.room, group: `x|${s._id}`, day: s.day, startMinutes: s.startMinutes, endMinutes: s.endMinutes,
  }));
  const usedMinutes = new Map();
  if (b.keepExisting) {
    for (const s of mine) {
      existing.push({
        teacher: String(s.teacher), room: s.room, group: groupOf(s.semester, s.course?.section), day: s.day,
        startMinutes: s.startMinutes, endMinutes: s.endMinutes,
      });
      usedMinutes.set(String(s.course?._id), (usedMinutes.get(String(s.course?._id)) || 0) + (s.endMinutes - s.startMinutes));
    }
  }

  const classes = ready
    .map((c) => ({
      id: String(c._id),
      group: groupOf(c.semester, c.section),
      teacher: String(c.teacher._id),
      sessions: Math.max(Math.max(c.creditHours || 1, 1) - Math.floor((usedMinutes.get(String(c._id)) || 0) / PERIOD), 0),
    }))
    .filter((c) => c.sessions > 0);

  const result = classes.length
    ? buildSchedule({ classes, days: b.days, periods, rooms: uniqueRooms, existing, seed: b.seed })
    : { placements: [], unplaced: [], score: 0 };

  const byId = new Map(ready.map((c) => [String(c._id), c]));
  const slots = result.placements.map((p, i) => {
    const c = byId.get(p.classId);
    return {
      _id: `preview-${i}`,
      course: { _id: c._id, code: c.code, title: c.title, section: c.section, creditHours: c.creditHours },
      teacher: { _id: c.teacher._id, name: c.teacher.name },
      semester: { _id: c.semester, name: semName.get(String(c.semester)) },
      room: p.room,
      day: p.day,
      startTime: hhmm(p.start),
      endTime: hhmm(p.end),
    };
  });

  const perTeacher = new Map();
  for (const s of slots) perTeacher.set(s.teacher.name, (perTeacher.get(s.teacher.name) || 0) + 1);

  return {
    semesters,
    result,
    byId,
    classes,
    slots,
    preview: {
      seed: b.seed,
      hours: `${b.startTime} - ${b.endTime}`,
      periodsPerDay: periods.length,
      days: b.days,
      rooms: uniqueRooms,
      requested: classes.reduce((s, c) => s + c.sessions, 0),
      placed: slots.length,
      kept: b.keepExisting ? mine.length : 0,
      slots,
      unplaced: result.unplaced.map((u) => {
        const c = byId.get(u.classId);
        return { semester: semName.get(String(c.semester)), code: c.code, title: c.title, teacher: c.teacher.name, missing: u.missing };
      }),
      noTeacher: noTeacher.map((c) => ({ semester: semName.get(String(c.semester)), code: c.code, title: c.title })),
      teacherLoad: [...perTeacher].map(([name, classesPerWeek]) => ({ name, classesPerWeek })).sort((a, b2) => b2.classesPerWeek - a.classesPerWeek),
    },
  };
};

// Preview (apply = false) or save (apply = true) an automatic timetable for the HOD's department.
// Saving replaces the classes of the chosen semesters (unless keepExisting) and leaves published/draft status as it was.
// When a published timetable changes, its students and teachers are notified.
export const generateTimetable = asyncHandler(async (req, res) => {
  const b = req.body;
  const p = await plan(req.user, b);
  if (!b.apply) return sendSuccess(res, p.preview, 'Preview ready. Nothing was saved yet');

  const planned = new Set(p.slots.map((s) => String(s.semester._id)));
  // Semesters that had courses ready are re-arranged; semesters without any ready course keep what they have.
  const readySems = [...new Set([...p.byId.values()].map((c) => String(c.semester)))];
  let saved = 0;

  if (!b.keepExisting) await TimetableSlot.deleteMany({ semester: { $in: readySems } });
  for (const sem of p.semesters.filter((s) => readySems.includes(String(s._id)))) {
    const timetable = await Timetable.findOneAndUpdate(
      { semester: sem._id },
      { $setOnInsert: { department: sem.department, status: TIMETABLE_STATUS.DRAFT } },
      { upsert: true, new: true }
    );
    const docs = p.result.placements
      .filter((x) => String(p.byId.get(x.classId).semester) === String(sem._id))
      .map((x) => {
        const c = p.byId.get(x.classId);
        return {
          timetable: timetable._id, department: sem.department, semester: sem._id, course: c._id, teacher: c.teacher._id,
          room: x.room, day: x.day, startTime: hhmm(x.start), endTime: hhmm(x.end), startMinutes: x.start, endMinutes: x.end,
        };
      });
    if (docs.length) await TimetableSlot.insertMany(docs);
    saved += docs.length;
    await Timetable.updateOne({ _id: timetable._id }, { $inc: { version: 1 } });

    if (timetable.status === TIMETABLE_STATUS.PUBLISHED) {
      const [students, teachers] = await Promise.all([
        CourseEnrollment.find({ semester: sem._id, status: ENROLLMENT_STATUS.ENROLLED }).distinct('student'),
        TimetableSlot.find({ timetable: timetable._id }).distinct('teacher'),
      ]);
      await notifyUsers([...students, ...teachers], {
        title: 'Timetable updated',
        message: `The timetable of ${sem.name} was re-arranged. Please check your new schedule`,
        type: 'timetable',
        link: '/my-timetable',
      });
    }
  }

  logAudit(req, 'timetable.generate', 'Timetable', null, {
    semesters: readySems.length, saved, unplaced: p.preview.unplaced.length, seed: b.seed, keepExisting: b.keepExisting, planned: planned.size,
  });
  sendSuccess(res, { ...p.preview, slots: undefined, saved }, `${saved} classes saved to the timetable`);
});

// "Move this class": every free place for one class (the teacher, the semester and a room are all free there).
// The HOD picks one and the normal edit (with all its checks) moves the class.
export const slotOptions = asyncHandler(async (req, res) => {
  const slot = await TimetableSlot.findById(req.params.id).populate('semester', 'status').populate('course', 'section code').lean();
  if (!slot) throw ApiError.notFound('Timetable slot not found');
  assertDepartmentAccess(req.user, slot.department);
  if (!live(slot)) throw ApiError.badRequest('This semester is closed. Its timetable can no longer be changed');

  const length = slot.endMinutes - slot.startMinutes;
  const periods = makePeriods(toMin(req.query.startTime), toMin(req.query.endTime), length);
  const days = DAYS.filter((d, i) => i < 5 || d === slot.day);
  const rooms = await TimetableSlot.find({ department: slot.department }).distinct('room');

  const nearby = (
    await TimetableSlot.find({
      _id: { $ne: slot._id },
      $or: [{ teacher: slot.teacher }, { semester: slot.semester._id }, { room: { $in: rooms } }],
    }).populate('semester', 'status').populate('course', 'section').lean()
  ).filter(live);

  const section = slot.course?.section || 'A';
  const options = [];
  for (const day of days) {
    for (const p of periods) {
      if (day === slot.day && p.start === slot.startMinutes) continue;
      const clash = (x) => x.day === day && x.startMinutes < p.end && x.endMinutes > p.start;
      if (nearby.some((x) => clash(x) && String(x.teacher) === String(slot.teacher))) continue; // the teacher is busy
      if (nearby.some((x) => clash(x) && String(x.semester._id) === String(slot.semester._id) && (x.course?.section || 'A') === section)) continue; // the students are busy
      const taken = new Set(nearby.filter(clash).map((x) => x.room));
      const room = !taken.has(slot.room) ? slot.room : rooms.find((r) => !taken.has(r));
      if (!room) continue;
      options.push({ day, startTime: hhmm(p.start), endTime: hhmm(p.end), room, sameRoom: room === slot.room });
    }
  }
  sendSuccess(res, { current: { day: slot.day, startTime: slot.startTime, endTime: slot.endTime, room: slot.room }, options });
});
