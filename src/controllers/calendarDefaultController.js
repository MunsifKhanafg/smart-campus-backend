import { z } from 'zod';
import AcademicCalendar from '../models/AcademicCalendar.js';
import Department from '../models/Department.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { objectId } from '../validators/validate.js';
import { buildDefaultCalendar, CLIMATES, key } from '../services/calendarTemplates.js';
import { ROLES, DEPARTMENT_STATUS } from '../config/constants.js';

// "Create default calendar": the head / HOD is asked which calendar they want
//   hot area  = long summer vacation, short winter vacation
//   cold area = long winter vacation, short summer vacation
// and gets the semesters (start, midterm, finals, end), vacations and fixed national holidays of one academic year.
// The head creates a university-wide calendar (or one for a single department); an HOD creates one for their own department.
// Semesters the HOD creates afterwards take their start and end dates from it (services/semesterFromCalendar.js).

export const defaultCalendarQuery = z.object({
  climate: z.enum(['hot', 'cold']),
  year: z.coerce.number().int().min(2000).max(2100),
  holidays: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  department: objectId.optional(),
});
export const defaultCalendarSchema = z.object({
  climate: z.enum(['hot', 'cold']),
  year: z.number().int().min(2000).max(2100),
  holidays: z.boolean().default(true),
  department: objectId.nullable().optional(), // head only; empty = the whole university
  replace: z.boolean().default(false), // replace the default events that are already there for this year
});

const build = (q) => {
  try { return buildDefaultCalendar({ climate: q.climate, year: q.year, holidays: q.holidays }); } catch (e) { throw ApiError.badRequest(e.message); }
};
const show = (e) => ({ type: e.type, title: e.title, startDate: e.startDate, endDate: e.endDate, description: e.description });

// Whose calendar: the head chooses (university-wide = null, or one department); an HOD always their own department.
const scopeOf = async (user, department) => {
  const id = user.role === ROLES.UNIVERSITY_HEAD ? department || null : user.department;
  if (id) {
    const dept = await Department.findById(id);
    if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Department not found or not active');
  }
  return id;
};

// The two choices, with what each one means.
export const defaultCalendarOptions = asyncHandler(async (_req, res) => {
  const now = new Date();
  sendSuccess(res, {
    suggestedYear: now.getUTCMonth() >= 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(),
    options: Object.entries(CLIMATES).map(([id, c]) => ({ id, label: c.label, note: c.note, summerWeeks: c.summerWeeks, winterWeeks: c.winterWeeks })),
  });
});

// Shows the calendar before it is saved. Nothing is written.
export const previewDefaultCalendar = asyncHandler(async (req, res) => {
  const cal = build(req.query);
  sendSuccess(res, { climate: cal.climate, note: cal.note, nextFallStart: cal.nextFallStart, events: cal.events.map(show) });
});

export const createDefaultCalendar = asyncHandler(async (req, res) => {
  const { climate, year, holidays, replace } = req.body;
  const deptId = await scopeOf(req.user, req.body.department);
  const cal = build({ climate, year, holidays });
  const from = cal.events[0].startDate;
  const to = new Date(cal.nextFallStart.getTime() - 1);
  const scope = { department: deptId };
  const range = { startDate: { $gte: from, $lte: to } };

  if (replace) await AcademicCalendar.deleteMany({ ...scope, ...range, source: 'default' });
  // A semester start that is already in this period (typed by hand, or a default calendar chosen earlier) would be doubled.
  const existing = await AcademicCalendar.countDocuments({ ...scope, ...range, type: 'semester_start' });
  if (existing) {
    throw ApiError.conflict(`This period (${key(from)} to ${key(to)}) already has ${existing} semester start(s) in the calendar. Tick "Replace the default calendar" to create it again, or delete the entries you made by hand first`);
  }

  const docs = await AcademicCalendar.insertMany(cal.events.map((e) => ({ ...e, department: deptId, semester: null, createdBy: req.user._id })));
  // insertMany does not fire the per-event hook, so the dated course contents are recalculated once for the whole period.
  try {
    const { recalcForCalendarEvent } = await import('../services/teachingCalendarService.js');
    await recalcForCalendarEvent({ department: deptId, semester: null, startDate: from, endDate: to });
  } catch (err) {
    console.error('Calendar schedule recalculation failed:', err.message);
  }
  logAudit(req, 'calendar.default_create', 'AcademicCalendar', null, { climate, year, department: deptId ? String(deptId) : 'university', events: docs.length, replace });
  sendSuccess(res, { created: docs.length, climate: cal.climate, from, to }, `${cal.climate} calendar created: ${docs.length} entries (${key(from)} to ${key(to)})`, 201);
});
