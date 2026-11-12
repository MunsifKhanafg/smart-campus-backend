import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import Department from '../models/Department.js';
import StudentProfile from '../models/StudentProfile.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { autoEnrollSemester } from '../services/enrollmentService.js';
import { computeEndDate, DEFAULT_SEMESTER_WEEKS } from '../services/semesterDates.js';
import { suggestSemesterDates, endFromCalendar } from '../services/semesterFromCalendar.js';
import { recalcSemester } from '../services/teachingCalendarService.js';
import Attendance from '../models/Attendance.js';
import Examination from '../models/Examination.js';
import FeeNotice from '../models/FeeNotice.js';
import Result from '../models/Result.js';
import CourseTopic from '../models/CourseTopic.js';
import Assignment from '../models/Assignment.js';
import Quiz from '../models/Quiz.js';
import Timetable from '../models/Timetable.js';
import TimetableSlot from '../models/TimetableSlot.js';
import AcademicCalendar from '../models/AcademicCalendar.js';
import { ROLES, DEPARTMENT_STATUS, SEMESTER_STATUS, STUDENT_STATUS } from '../config/constants.js';
import Submission from '../models/Submission.js';
import QuizAttempt from '../models/QuizAttempt.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import ExaminationAdmission from '../models/ExaminationAdmission.js';
import DMC from '../models/DMC.js';
import MaterialChunk from '../models/MaterialChunk.js';
import AIConversation from '../models/AIConversation.js';
import Complaint from '../models/Complaint.js';
import FeeCart from '../models/FeeCart.js';
import Payment from '../models/Payment.js';
import { removeStoredAnywhere } from '../middleware/upload.js';

const findSemester = async (id) => {
  const semester = await Semester.findById(id).populate('department', 'name code');
  if (!semester) throw ApiError.notFound('Semester not found');
  return semester;
};

// Head may look at any department (optionally filtered). Everyone else is locked to their own.
export const listSemesters = asyncHandler(async (req, res) => {
  const { department, status } = req.query;
  const filter = {};
  if (req.user.role === ROLES.UNIVERSITY_HEAD || req.user.role === ROLES.FINANCE_OFFICER) {
    if (department) filter.department = department;
  } else {
    filter.department = req.user.department;
  }
  if (status) filter.status = status;
  const semesters = await Semester.find(filter)
    .populate('department', 'name code')
    .sort({ academicYear: -1, number: 1 });
  sendSuccess(res, semesters);
});

export const getSemester = asyncHandler(async (req, res) => {
  const semester = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, semester.department._id);
  sendSuccess(res, semester);
});

// The calendar entries that decide semester dates: university-wide ones and the department's own.
const calendarEvents = (departmentId) =>
  AcademicCalendar.find({ type: { $in: ['semester_start', 'semester_end', 'final_exam'] }, $or: [{ department: null }, { department: departmentId }] }).lean();

// What the academic calendar says about the next semester (the create form shows it before saving). null = the calendar has none yet.
export const calendarDates = asyncHandler(async (req, res) => {
  const events = await calendarEvents(req.user.department);
  sendSuccess(res, suggestSemesterDates({ events, departmentId: req.user.department }));
});

// Only an HOD creates semesters, and always inside their own department.
export const createSemester = asyncHandler(async (req, res) => {
  const dept = await Department.findById(req.user.department);
  if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Your department is not active');

  // The dates come from the ACADEMIC CALENDAR. Start date left empty: the next semester start of the calendar is used, with its end
  // (the calendar's "semester ends", else the end of the final examinations, else start + duration). A typed start date still gets
  // its end from the calendar when it has one. An end date typed by hand always wins and is kept (endDateManual).
  const { endDate: typedEnd, startDate: typedStart, durationWeeks, ...rest } = req.body;
  const weeks = durationWeeks || DEFAULT_SEMESTER_WEEKS;
  const events = await calendarEvents(dept._id);
  let startDate = typedStart;
  let endDate = typedEnd;
  let source = 'the dates you typed';
  if (!startDate) {
    const s = suggestSemesterDates({ events, departmentId: dept._id, weeks });
    if (!s) throw ApiError.badRequest('The academic calendar has no semester start yet. Create the default calendar (Calendar > Default calendar), or type the start date');
    startDate = s.startDate;
    endDate = endDate || s.endDate;
    source = s.source;
  } else if (!endDate) {
    const e = endFromCalendar({ events, start: startDate, departmentId: dept._id });
    if (e) { endDate = e.endDate; source = e.source; }
  }
  const semester = await Semester.create({
    ...rest,
    startDate,
    durationWeeks: weeks,
    endDate: endDate || computeEndDate(startDate, weeks),
    endDateManual: !!typedEnd,
    department: dept._id,
    createdBy: req.user._id,
  });
  logAudit(req, 'semester.create', 'Semester', semester._id, { name: semester.name, startDate: semester.startDate, endDate: semester.endDate, source });
  const day = (d) => d.toISOString().slice(0, 10);
  sendSuccess(res, await findSemester(semester._id), `Semester created: ${day(semester.startDate)} to ${day(semester.endDate)} (from ${source})`, 201);
});

export const updateSemester = asyncHandler(async (req, res) => {
  const semester = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, semester.department._id);
  if (semester.status === SEMESTER_STATUS.ARCHIVED) throw ApiError.badRequest('Archived semesters cannot be edited');

  // Start date or duration changed -> the end date is calculated again, unless the same request sets an end date by hand.
  // An end date typed by hand is kept (endDateManual) until the start date or the duration changes again.
  const { startDate, endDate, durationWeeks, ...rest } = req.body;
  semester.set(rest);
  const before = { start: +semester.startDate, end: +semester.endDate };
  if (durationWeeks !== undefined) semester.durationWeeks = durationWeeks;
  if (startDate) semester.startDate = startDate;
  if (endDate) {
    semester.endDate = endDate;
    semester.endDateManual = true;
  } else if (startDate || durationWeeks !== undefined) {
    // A new start date alone follows the calendar (its "semester ends"); a new duration is the HOD's decision and wins.
    const fromCalendar = startDate && durationWeeks === undefined
      ? endFromCalendar({ events: await calendarEvents(semester.department._id), start: semester.startDate, departmentId: semester.department._id })
      : null;
    semester.endDate = fromCalendar?.endDate || computeEndDate(semester.startDate, semester.durationWeeks);
    semester.endDateManual = false;
  }
  await semester.save(); // model re-checks end date > start date on the merged values

  // Course content follows the semester: topics placed by the scheduler move to real teaching days inside the new dates.
  const datesChanged = before.start !== +semester.startDate || before.end !== +semester.endDate;
  const moved = datesChanged ? await recalcSemester(semester._id) : 0;
  const outside = datesChanged
    ? await CourseTopic.countDocuments({
        semester: semester._id,
        autoScheduled: false,
        $or: [{ scheduledDate: { $lt: semester.startDate } }, { scheduledDate: { $gt: new Date(+semester.endDate + 86399999) } }],
      })
    : 0;
  logAudit(req, 'semester.update', 'Semester', semester._id, { fields: Object.keys(req.body), endDate: semester.endDate, topicsMoved: moved });
  const notes = [];
  if (moved) notes.push(`${moved} topic date(s) were recalculated`);
  if (outside) notes.push(`${outside} topic(s) with a date you set by hand are outside the new semester dates. Please check them`);
  sendSuccess(res, semester, `Semester updated. It ends on ${semester.endDate.toISOString().slice(0, 10)}${notes.length ? `. ${notes.join('. ')}` : ''}`);
});

export const setSemesterStatus = asyncHandler(async (req, res) => {
  const semester = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, semester.department._id);
  semester.status = req.body.status;
  await semester.save();
  logAudit(req, `semester.${req.body.status}`, 'Semester', semester._id);
  sendSuccess(res, semester, `Semester marked ${req.body.status}`);
});

// Everything that lives inside a semester. Used both to show the HOD what a delete would remove (preview) and to do it.
const gatherSemesterData = async (semesterId) => {
  const [courseIds, examIds, noticeIds] = await Promise.all([
    Course.find({ semester: semesterId }).distinct('_id'),
    Examination.find({ semester: semesterId }).distinct('_id'),
    FeeNotice.find({ semester: semesterId }).distinct('_id'),
  ]);
  const bySem = { semester: semesterId };
  const byCourse = { course: { $in: courseIds } };

  const [students, enrollments, attendance, topics, assignments, submissions, quizzes, attempts, marks, results, admissions, payments] =
    await Promise.all([
      StudentProfile.countDocuments(bySem),
      CourseEnrollment.countDocuments(bySem),
      Attendance.countDocuments(bySem),
      CourseTopic.countDocuments(bySem),
      Assignment.countDocuments(bySem),
      Submission.countDocuments(byCourse),
      Quiz.countDocuments(bySem),
      QuizAttempt.countDocuments(byCourse),
      ExaminationMarks.countDocuments({ $or: [byCourse, { examination: { $in: examIds } }] }),
      Result.countDocuments(bySem),
      ExaminationAdmission.countDocuments(bySem),
      // Money that was really paid is a financial record and is never deleted with a semester.
      Payment.countDocuments({ 'items.notice': { $in: noticeIds }, status: { $in: ['paid', 'refunded'] } }),
    ]);

  const items = [
    [courseIds.length, 'courses (with their timetable slots)'],
    [examIds.length, 'examinations and date sheets'],
    [noticeIds.length, 'fee notices'],
    [enrollments, 'course enrollments'],
    [attendance, 'attendance sheets'],
    [topics, 'teaching topics and materials'],
    [assignments, 'assignments and presentations'],
    [submissions, 'assignment submissions'],
    [quizzes, 'quizzes'],
    [attempts, 'quiz attempts'],
    [marks, 'examination marks'],
    [results, 'results and DMCs'],
    [admissions, 'examination admission requests'],
  ]
    .filter(([n]) => n > 0)
    .map(([count, label]) => ({ count, label }));

  const hasRecords = items.some((i) => !i.label.startsWith('courses')) || students > 0;
  return { courseIds, examIds, noticeIds, students, payments, items, hasRecords };
};

// What would be deleted? The HOD sees this in the confirmation window before anything happens.
export const previewSemesterDelete = asyncHandler(async (req, res) => {
  const semester = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, semester.department._id);
  const d = await gatherSemesterData(semester._id);
  sendSuccess(res, {
    name: semester.name,
    items: d.items,
    students: d.students,
    hasRecords: d.hasRecords,
    blockedByPayments: d.payments,
  });
});

// Delete a semester together with everything inside it: its courses, timetable, calendar events, examinations, fee
// notices, results, attendance, topics, assignments, quizzes and uploaded files.
// Students are NOT deleted. They stay in the department and are only taken out of this semester.
// Paid or refunded payments are financial records, so a semester that has them cannot be deleted (archive it instead).
// When the semester contains records, the caller must confirm with ?force=true (the web page does this after the
// HOD has read the list and typed DELETE).
export const deleteSemester = asyncHandler(async (req, res) => {
  const semester = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, semester.department._id);
  const d = await gatherSemesterData(semester._id);

  if (d.payments > 0) {
    throw ApiError.badRequest(
      `This semester cannot be deleted because ${d.payments} fee payment(s) were already made for it. Payments are financial records and must be kept. Mark the semester as archived instead.`
    );
  }
  if (d.hasRecords && req.query.force !== 'true') {
    throw ApiError.conflict('This semester contains records. Please confirm to delete it together with everything inside it.');
  }

  const bySem = { semester: semester._id };
  const byCourse = { course: { $in: d.courseIds } };

  // Uploaded files (topic materials, assignment instructions, student submissions) are removed from disk too.
  const [topics, assignments, submissions] = await Promise.all([
    CourseTopic.find(bySem).select('materials'),
    Assignment.find(bySem).select('attachments'),
    Submission.find(byCourse).select('files'),
  ]);
  const files = [
    ...topics.flatMap((t) => t.materials || []),
    ...assignments.flatMap((a) => a.attachments || []),
    ...submissions.flatMap((s) => s.files || []),
  ];

  const results = await Result.find(bySem).distinct('_id');
  await Promise.all([
    Submission.deleteMany(byCourse),
    QuizAttempt.deleteMany(byCourse),
    MaterialChunk.deleteMany(byCourse),
    AIConversation.deleteMany(byCourse),
    Attendance.deleteMany(bySem),
    CourseTopic.deleteMany(bySem),
    Assignment.deleteMany(bySem),
    Quiz.deleteMany(bySem),
    CourseEnrollment.deleteMany(bySem),
    ExaminationMarks.deleteMany({ $or: [byCourse, { examination: { $in: d.examIds } }] }),
    DMC.deleteMany({ $or: [{ result: { $in: results } }, { examination: { $in: d.examIds } }] }),
    Result.deleteMany(bySem),
    ExaminationAdmission.deleteMany(bySem),
    Examination.deleteMany(bySem),
    // Payments that never completed (pending / failed) and carts that point at these notices go away with them.
    Payment.deleteMany({ 'items.notice': { $in: d.noticeIds } }),
    FeeCart.updateMany({ 'items.notice': { $in: d.noticeIds } }, { $pull: { items: { notice: { $in: d.noticeIds } } } }),
    FeeNotice.deleteMany(bySem),
    Complaint.updateMany({ relatedCourse: { $in: d.courseIds } }, { relatedCourse: null }),
    TimetableSlot.deleteMany(bySem),
    Timetable.deleteMany(bySem),
    AcademicCalendar.deleteMany(bySem),
    // Students stay. They are only taken out of the deleted semester.
    StudentProfile.updateMany(bySem, { semester: null }),
  ]);
  await Course.deleteMany(bySem);
  await semester.deleteOne();
  removeStoredAnywhere(files);

  logAudit(req, 'semester.delete', 'Semester', semester._id, {
    name: semester.name,
    removed: Object.fromEntries(d.items.map((i) => [i.label, i.count])),
    studentsUnplaced: d.students,
  });
  sendSuccess(res, null, 'Semester deleted');
});

// Moves students from a finished semester into the next one (for example semester 1 -> semester 2).
// The HOD chooses who moves, so students who failed or are held back can stay. Old enrollments stay as history.
export const promoteSemester = asyncHandler(async (req, res) => {
  const from = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, from.department._id);
  if (from.status === SEMESTER_STATUS.ARCHIVED) throw ApiError.badRequest('An archived semester cannot promote students');

  const finished = from.status === SEMESTER_STATUS.COMPLETED || from.endDate <= new Date();
  if (!finished) {
    throw ApiError.badRequest(`This semester has not finished yet. It ends on ${from.endDate.toISOString().slice(0, 10)}`);
  }

  const to = await Semester.findById(req.body.toSemester);
  if (!to) throw ApiError.notFound('Target semester not found');
  if (String(to.department) !== String(from.department._id)) throw ApiError.badRequest('The next semester must be in the same department');
  if ([SEMESTER_STATUS.COMPLETED, SEMESTER_STATUS.ARCHIVED].includes(to.status)) {
    throw ApiError.badRequest(`The next semester is ${to.status}. Choose an open semester`);
  }
  if (to.number <= from.number) throw ApiError.badRequest('Students can only move to a higher semester number');

  const filter = { semester: from._id, department: from.department._id, status: STUDENT_STATUS.ACTIVE };
  if (req.body.students?.length) filter._id = { $in: req.body.students };
  const profiles = await StudentProfile.find(filter);
  if (!profiles.length) throw ApiError.badRequest('There are no active students to promote in this semester');
  if (req.body.students?.length && profiles.length !== new Set(req.body.students).size) {
    throw ApiError.badRequest('Some selected students are not in this semester or are not active');
  }

  await StudentProfile.updateMany({ _id: { $in: profiles.map((p) => p._id) } }, { semester: to._id });
  const refreshed = await StudentProfile.find({ _id: { $in: profiles.map((p) => p._id) } });
  const enrollment = await autoEnrollSemester(refreshed, to._id, req.user._id);

  // Close the old semester only when nobody is left in it (held-back students still need it open).
  const remaining = await StudentProfile.countDocuments({ semester: from._id, status: STUDENT_STATUS.ACTIVE });
  let completed = from.status === SEMESTER_STATUS.COMPLETED;
  if (!remaining && !completed) {
    from.status = SEMESTER_STATUS.COMPLETED;
    await from.save();
    completed = true;
  }

  await notifyUsers(refreshed.map((p) => p.user), {
    title: 'Promoted to the next semester',
    message: `You have been moved to ${to.name}`,
    type: 'promotion',
    link: '/my-courses',
  });

  logAudit(req, 'semester.promote', 'Semester', from._id, { to: to.name, students: profiles.length, remaining });
  sendSuccess(
    res,
    { promoted: profiles.length, remaining, semesterCompleted: completed, to: { _id: to._id, name: to.name }, ...enrollment },
    `${profiles.length} student(s) moved to ${to.name}`
  );
});

// Small summary used by the HOD screens (how many courses, how many still without a teacher).
export const semesterSummary = asyncHandler(async (req, res) => {
  const semester = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, semester.department._id);
  const [courses, unassigned] = await Promise.all([
    Course.countDocuments({ semester: semester._id, status: 'active' }),
    Course.countDocuments({ semester: semester._id, status: 'active', teacher: null }),
  ]);
  sendSuccess(res, { semester, courses, unassigned });
});

// Everyone placed in this semester, with contact details and a summary of their course enrollment.
// Principal: any department. HOD: own department only.
export const semesterRoster = asyncHandler(async (req, res) => {
  const semester = await findSemester(req.params.id);
  assertDepartmentAccess(req.user, semester.department._id);

  const profiles = await StudentProfile.find({ semester: semester._id }).populate('user', 'name email phone isActive hasPhoto photoUpdatedAt').sort({ rollNumber: 1 }).lean();
  const enrolments = await CourseEnrollment.aggregate([
    { $match: { semester: semester._id, student: { $in: profiles.map((p) => p.user?._id).filter(Boolean) }, status: 'enrolled' } },
    { $group: { _id: '$student', courses: { $sum: 1 }, since: { $min: '$enrolledAt' } } },
  ]);
  const byStudent = new Map(enrolments.map((e) => [String(e._id), e]));
  const courses = await Course.countDocuments({ semester: semester._id, status: 'active' });

  sendSuccess(res, {
    semester,
    total: profiles.length,
    activeCourses: courses,
    students: profiles.map((p) => {
      const e = byStudent.get(String(p.user?._id));
      return {
        profileId: p._id,
        userId: p.user?._id,
        name: p.user?.name,
        email: p.user?.email,
        phone: p.user?.phone || '',
        hasPhoto: !!p.user?.hasPhoto,
        photoUpdatedAt: p.user?.photoUpdatedAt || null,
        rollNumber: p.rollNumber,
        section: p.section,
        admissionYear: p.admissionYear || null,
        guardianName: p.guardianName,
        guardianPhone: p.guardianPhone,
        address: p.address,
        status: p.status,
        coursesEnrolled: e?.courses || 0,
        enrolledSince: e?.since || null,
      };
    }),
  });
});
