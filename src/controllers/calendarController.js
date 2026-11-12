import AcademicCalendar from '../models/AcademicCalendar.js';
import Department from '../models/Department.js';
import Semester from '../models/Semester.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { ROLES, DEPARTMENT_STATUS } from '../config/constants.js';
import { pickSemesterDates, startYearOf } from '../services/semesterDates.js';

const populateEvent = (q) => q.populate('department', 'name code').populate('semester', 'name academicYear');

// Everyone sees university-wide events plus events of their own department.
// A student additionally only sees semester-specific events of their own semester.
export const listEvents = asyncHandler(async (req, res) => {
  const { from, to, department, semester } = req.query;
  const and = [];

  if (req.user.role === ROLES.UNIVERSITY_HEAD) {
    if (department) and.push({ department });
    if (semester) and.push({ semester });
  } else {
    and.push({ $or: [{ department: null }, { department: req.user.department }] });
    if (req.user.role === ROLES.STUDENT) {
      const profile = await StudentProfile.findOne({ user: req.user._id }).select('semester');
      and.push({ $or: [{ semester: null }, ...(profile?.semester ? [{ semester: profile.semester }] : [])] });
    } else if (semester) {
      and.push({ semester });
    }
  }
  if (from) and.push({ endDate: { $gte: from } });
  if (to) and.push({ startDate: { $lte: to } });

  const events = await populateEvent(AcademicCalendar.find(and.length ? { $and: and } : {})).sort({ startDate: 1 });
  sendSuccess(res, events);
});

// Head: university-wide (department null) or for any department. HOD: always their own department.
export const createEvent = asyncHandler(async (req, res) => {
  const isHead = req.user.role === ROLES.UNIVERSITY_HEAD;
  const { department, semester: semesterId, ...rest } = req.body;

  const deptId = isHead ? department || null : req.user.department;
  if (deptId) {
    const dept = await Department.findById(deptId);
    if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Department not found or not active');
  }
  if (semesterId) {
    if (!deptId) throw ApiError.badRequest('A semester-specific event needs a department');
    const semester = await Semester.findById(semesterId);
    if (!semester || String(semester.department) !== String(deptId)) {
      throw ApiError.badRequest('Semester does not belong to this department');
    }
  }

  const event = await AcademicCalendar.create({
    ...rest,
    department: deptId,
    semester: semesterId || null,
    createdBy: req.user._id,
  });
  logAudit(req, 'calendar.create', 'AcademicCalendar', event._id, { title: event.title, type: event.type });
  sendSuccess(res, await populateEvent(AcademicCalendar.findById(event._id)), 'Event added', 201);
});

// For the new-semester form of an HOD: the start and end dates the academic calendar gives to this semester number in this academic year.
// Odd semesters follow the first term of the year, even semesters the second. The HOD can still change the dates by hand.
export const semesterDates = asyncHandler(async (req, res) => {
  const startYear = startYearOf(req.query.academicYear);
  const number = Number(req.query.number);
  if (!startYear || !Number.isInteger(number) || number < 1) throw ApiError.badRequest('Enter the semester number and the academic year first');
  const events = await AcademicCalendar.find({
    type: { $in: ['semester_start', 'semester_end'] },
    $or: [{ department: null }, { department: req.user.department }],
  }).select('type title startDate endDate department').lean();
  sendSuccess(res, pickSemesterDates({ events, number, startYear, departmentId: req.user.department }));
});

// An HOD can only change events of their own department. University-wide events belong to the head.
const loadEditableEvent = async (user, id) => {
  const event = await AcademicCalendar.findById(id);
  if (!event) throw ApiError.notFound('Event not found');
  if (user.role !== ROLES.UNIVERSITY_HEAD) {
    if (!event.department || String(event.department) !== String(user.department)) {
      throw ApiError.forbidden('You can only change events of your own department');
    }
  }
  return event;
};

export const updateEvent = asyncHandler(async (req, res) => {
  const event = await loadEditableEvent(req.user, req.params.id);
  if (req.body.semester) {
    const semester = await Semester.findById(req.body.semester);
    if (!event.department || !semester || String(semester.department) !== String(event.department)) {
      throw ApiError.badRequest('Semester does not belong to this event\'s department');
    }
  }
  event.set(req.body);
  await event.save(); // model re-checks end date >= start date
  logAudit(req, 'calendar.update', 'AcademicCalendar', event._id, { fields: Object.keys(req.body) });
  sendSuccess(res, await populateEvent(AcademicCalendar.findById(event._id)), 'Event updated');
});

export const deleteEvent = asyncHandler(async (req, res) => {
  const event = await loadEditableEvent(req.user, req.params.id);
  await event.deleteOne();
  logAudit(req, 'calendar.delete', 'AcademicCalendar', event._id, { title: event.title });
  sendSuccess(res, null, 'Event deleted');
});
