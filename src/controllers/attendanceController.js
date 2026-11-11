import Attendance from '../models/Attendance.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { dayStart, round2 } from '../utils/oid.js';
import { getCourseFor, enrolledStudentIds, studentCourseIds } from '../services/accessService.js';
import { attendancePercent, attendanceCounts, emptyCounts } from '../services/attendanceService.js';
import { ROLES } from '../config/constants.js';
import { studentsOnLeave } from './studentLeaveController.js';

const rulesOf = async () => {
  const s = await UniversitySettings.getSettings();
  return { allowLeave: s.attendanceRules.allowApprovedLeaveAsPresent, minPercent: s.admissionRules.minAttendancePercentage };
};

// Teacher opens the attendance sheet of one day: every enrolled student with the status already saved (if any).
export const getSheet = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  const date = dayStart(req.query.date || new Date());
  const [studentIds, existing] = await Promise.all([
    enrolledStudentIds(course._id),
    Attendance.findOne({ course: course._id, date }),
  ]);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: studentIds } }).select('name').lean(),
    StudentProfile.find({ user: { $in: studentIds } }).select('user rollNumber').lean(),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  const saved = new Map((existing?.records || []).map((r) => [String(r.student), r.status]));
  // A student whose leave was approved for this day starts as "leave" (the teacher can still change it).
  const onLeave = await studentsOnLeave(date, studentIds);

  const students = users
    .map((u) => ({ student: u._id, name: u.name, rollNumber: roll.get(String(u._id)) || '', status: saved.get(String(u._id)) || (onLeave.has(String(u._id)) ? 'leave' : null), onApprovedLeave: onLeave.has(String(u._id)) }))
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));
  sendSuccess(res, { date, alreadyMarked: !!existing, students });
});

export const saveAttendance = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'write');
  const date = dayStart(req.body.date);

  if (date > dayStart(new Date())) throw ApiError.badRequest('Attendance cannot be marked for a future date');
  if (course.startDate && date < dayStart(course.startDate)) throw ApiError.badRequest('This date is before the course starts');
  if (course.endDate && date > dayStart(course.endDate)) throw ApiError.badRequest('This date is after the course ended');

  const enrolled = (await enrolledStudentIds(course._id)).map(String);
  const sent = req.body.records.map((r) => String(r.student));
  if (new Set(sent).size !== sent.length) throw ApiError.badRequest('A student appears twice in the sheet');
  if (sent.some((id) => !enrolled.includes(id))) throw ApiError.badRequest('The sheet contains a student who is not enrolled in this course');
  if (enrolled.some((id) => !sent.includes(id))) throw ApiError.badRequest('Please mark every enrolled student (present, absent or leave)');

  // "Absent" for a student whose leave was approved for this day is saved as "leave".
  const onLeave = await studentsOnLeave(date, enrolled);
  const records = req.body.records.map((r) => (r.status === 'absent' && onLeave.has(String(r.student)) ? { ...r, status: 'leave' } : r));

  const doc = await Attendance.findOneAndUpdate(
    { course: course._id, date },
    { $set: { records, markedBy: req.user._id, department: course.department, semester: course.semester._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  logAudit(req, 'attendance.save', 'Attendance', doc._id, { course: course.code, date: date.toISOString().slice(0, 10) });
  sendSuccess(res, { _id: doc._id, date: doc.date, count: doc.records.length }, 'Attendance saved');
});

// Per-student totals for one course (teacher, HOD, head).
export const courseSummary = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  const { allowLeave, minPercent } = await rulesOf();
  const studentIds = await enrolledStudentIds(course._id);
  const [counts, users, profiles, sessions] = await Promise.all([
    attendanceCounts({ courseIds: [course._id], studentIds }),
    User.find({ _id: { $in: studentIds } }).select('name').lean(),
    StudentProfile.find({ user: { $in: studentIds } }).select('user rollNumber').lean(),
    Attendance.countDocuments({ course: course._id }),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));

  const rows = users
    .map((u) => {
      const c = counts.get(`${course._id}:${u._id}`) || emptyCounts();
      const percent = attendancePercent(c, allowLeave);
      return { student: u._id, name: u.name, rollNumber: roll.get(String(u._id)) || '', ...c, percent, belowLimit: percent !== null && percent < minPercent };
    })
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));
  sendSuccess(res, { course: { _id: course._id, code: course.code, title: course.title }, sessions, minPercent, rows });
});

// The student's own attendance: totals, percentage and day-by-day history, per course.
export const myAttendance = asyncHandler(async (req, res) => {
  const { allowLeave, minPercent } = await rulesOf();
  let courseIds = await studentCourseIds(req.user._id);
  if (req.query.course) courseIds = courseIds.filter((id) => String(id) === req.query.course);

  const [courses, counts, history] = await Promise.all([
    Course.find({ _id: { $in: courseIds } }).select('code title section').lean(),
    attendanceCounts({ courseIds, studentIds: [req.user._id] }),
    Attendance.find({ course: { $in: courseIds }, 'records.student': req.user._id })
      .select({ course: 1, date: 1, records: { $elemMatch: { student: req.user._id } } })
      .sort({ date: -1 })
      .lean(),
  ]);

  const rows = courses.map((c) => {
    const cnt = counts.get(`${c._id}:${req.user._id}`) || emptyCounts();
    const percent = attendancePercent(cnt, allowLeave);
    return {
      course: c,
      ...cnt,
      percent,
      belowLimit: percent !== null && percent < minPercent,
      history: history.filter((h) => String(h.course) === String(c._id)).map((h) => ({ date: h.date, status: h.records[0].status })),
    };
  });
  sendSuccess(res, { minPercent, rows });
});

// Session history of one course: one line per day attendance was taken, with that day's totals.
export const courseSessions = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  const docs = await Attendance.find({ course: course._id }).select('date records.status').sort({ date: -1 }).lean();
  sendSuccess(
    res,
    docs.map((d) => {
      const c = { present: 0, absent: 0, leave: 0 };
      for (const r of d.records) c[r.status] = (c[r.status] || 0) + 1;
      return { date: d.date, ...c, total: d.records.length };
    })
  );
});

// A teacher's own classes with their attendance figures (students, sessions held, average, who is below the limit,
// whether today's attendance is already taken). Powers the teacher's Attendance page.
export const myClasses = asyncHandler(async (req, res) => {
  const { allowLeave, minPercent } = await rulesOf();
  const courses = await Course.find({ teacher: req.user._id, status: 'active' })
    .populate('semester', 'name number academicYear status')
    .select('code title section creditHours semester')
    .sort({ code: 1 })
    .lean();
  const ids = courses.map((c) => c._id);
  const [counts, sessions] = await Promise.all([
    attendanceCounts({ courseIds: ids }),
    Attendance.aggregate([{ $match: { course: { $in: ids } } }, { $group: { _id: '$course', sessions: { $sum: 1 }, last: { $max: '$date' } } }]),
  ]);
  const sess = new Map(sessions.map((s) => [String(s._id), s]));
  const today = dayStart(new Date()).getTime();

  const rows = [];
  for (const c of courses) {
    let sum = 0;
    let n = 0;
    let low = 0;
    for (const [key, cnt] of counts) {
      if (!key.startsWith(`${c._id}:`)) continue;
      const pct = attendancePercent(cnt, allowLeave);
      if (pct === null) continue;
      sum += pct;
      n += 1;
      if (pct < minPercent) low += 1;
    }
    const s = sess.get(String(c._id));
    rows.push({
      course: { _id: c._id, code: c.code, title: c.title, section: c.section, creditHours: c.creditHours },
      semester: c.semester,
      students: (await enrolledStudentIds(c._id)).length,
      sessions: s?.sessions || 0,
      lastDate: s?.last || null,
      markedToday: !!s && dayStart(s.last).getTime() === today,
      averagePercent: n ? round2(sum / n) : null,
      belowLimit: low,
    });
  }
  sendSuccess(res, { minPercent, rows });
});

// HOD (own department) or head (any): average attendance of every course.
export const departmentSummary = asyncHandler(async (req, res) => {
  const { allowLeave, minPercent } = await rulesOf();
  const filter = {};
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  else if (req.query.department) filter.department = req.query.department;
  if (req.query.semester) filter.semester = req.query.semester;

  const courses = await Course.find(filter).populate('teacher', 'name').populate('semester', 'name').select('code title section teacher semester').lean();
  const counts = await attendanceCounts({ courseIds: courses.map((c) => c._id) });

  const perCourse = new Map();
  for (const [key, c] of counts) {
    const [courseId] = key.split(':');
    const pct = attendancePercent(c, allowLeave);
    if (pct === null) continue;
    const agg = perCourse.get(courseId) || { sum: 0, n: 0, low: 0 };
    agg.sum += pct;
    agg.n += 1;
    if (pct < minPercent) agg.low += 1;
    perCourse.set(courseId, agg);
  }
  const rows = courses.map((c) => {
    const a = perCourse.get(String(c._id));
    return {
      course: { _id: c._id, code: c.code, title: c.title, section: c.section },
      semester: c.semester?.name,
      teacher: c.teacher?.name || null,
      students: a?.n || 0,
      averagePercent: a ? round2(a.sum / a.n) : null,
      belowLimit: a?.low || 0,
    };
  });
  sendSuccess(res, { minPercent, rows });
});
