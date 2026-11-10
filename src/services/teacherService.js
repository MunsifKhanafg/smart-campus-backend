import Course from '../models/Course.js';
import Department from '../models/Department.js';
import { ApiError } from '../utils/apiHelpers.js';
import { ROLES, COURSE_STATUS, DEPARTMENT_STATUS, CLOSED_SEMESTER_STATES } from '../config/constants.js';

// ============================================================================================================
// Teachers who work for more than one department, and each teacher's weekly teaching load.
//
// A teacher has ONE home department (user.department) and may be allowed to teach in other departments too
// (user.extraDepartments). Common subjects such as English, Mathematics, Islamiat or Pakistan Studies are taught in every
// department, so the same teacher can be given classes by several HODs without a second account.
// The HOD of any of those departments can pick this teacher when assigning a subject of THEIR department.
//
// Workload: a class takes "weekly classes" hours per week (the number the HOD sets on the subject; empty = its credit hours).
// The administrator may give each teacher a weekly limit (user.maxWeeklyHours). Empty = no limit. There is no fixed number any more.
// ============================================================================================================

// Does this teacher work in that department (home department or one of the extra ones)?
export const teachesIn = (teacher, departmentId) =>
  String(teacher.department?._id || teacher.department) === String(departmentId) ||
  (teacher.extraDepartments || []).some((d) => String(d._id || d) === String(departmentId));

// Active teachers / HODs that can be given a class of this department.
export const eligibleTeacherQuery = (departmentId) => ({
  role: { $in: [ROLES.TEACHER, ROLES.HOD] },
  isActive: true,
  $or: [{ department: departmentId }, { extraDepartments: departmentId }],
});

// Hours per week one class takes.
export const weeklyClassesOf = (course) => course.weeklyClasses || course.creditHours || 0;

// What a teacher teaches now, in ALL departments: classes that are active in semesters that are not finished.
export const weeklyLoad = async (teacherId, excludeCourseId = null) => {
  const filter = { teacher: teacherId, status: COURSE_STATUS.ACTIVE };
  if (excludeCourseId) filter._id = { $ne: excludeCourseId };
  const courses = await Course.find(filter).populate('semester', 'status').lean();
  const open = courses.filter((c) => c.semester && !CLOSED_SEMESTER_STATES.includes(c.semester.status));
  return { classes: open.length, hours: open.reduce((n, c) => n + weeklyClassesOf(c), 0) };
};

// Refuses an assignment that would take the teacher over the weekly limit the administrator set for them.
// No limit set = always allowed. `course` may be a class that does not exist yet (credit hours / weeklyClasses are enough).
export const assertWithinWeeklyLimit = async (teacher, course) => {
  if (!teacher.maxWeeklyHours) return;
  const { hours } = await weeklyLoad(teacher._id, course._id || null);
  const adding = weeklyClassesOf(course);
  if (hours + adding > teacher.maxWeeklyHours) {
    throw ApiError.conflict(
      `${teacher.name} is limited to ${teacher.maxWeeklyHours} teaching hours per week and already teaches ${hours}. ` +
      `${course.code || 'This class'} would add ${adding}. The principal or the HOD can change the limit under Users > Edit (Weekly teaching hours).`
    );
  }
};

// "English, Mathematics ,english" -> ["English", "Mathematics"]. Trimmed, no duplicates, sensible length.
export const cleanSubjects = (list = []) => {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const text = String(s).trim().replace(/\s+/g, ' ');
    const key = text.toLowerCase();
    if (text && !seen.has(key)) { seen.add(key); out.push(text.slice(0, 80)); }
  }
  return out.slice(0, 30);
};

// The other departments a teacher may work in. The home department is never listed here; every one must exist and be active.
export const cleanExtraDepartments = async (ids = [], homeDepartmentId) => {
  const unique = [...new Set(ids.map(String))].filter((id) => id !== String(homeDepartmentId));
  if (!unique.length) return [];
  const found = await Department.find({ _id: { $in: unique }, status: DEPARTMENT_STATUS.ACTIVE }).select('_id');
  if (found.length !== unique.length) throw ApiError.badRequest('One of the other departments was not found or is not active');
  return found.map((d) => d._id);
};
