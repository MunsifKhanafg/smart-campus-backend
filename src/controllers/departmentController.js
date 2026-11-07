import Department from '../models/Department.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { flatten } from '../utils/flatten.js';
import { ROLES, DEPARTMENT_STATUS } from '../config/constants.js';

const findDept = async (id) => {
  const dept = await Department.findById(id).populate('hod', 'name email');
  if (!dept) throw ApiError.notFound('Department not found');
  return dept;
};

export const listDepartments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role !== ROLES.UNIVERSITY_HEAD) {
    // Department isolation: non-head users only ever see their own department.
    filter._id = req.user.department;
  } else if (req.query.status) {
    filter.status = req.query.status;
  }
  const departments = await Department.find(filter).populate('hod', 'name email').sort({ name: 1 });
  sendSuccess(res, departments);
});

export const getDepartment = asyncHandler(async (req, res) => {
  assertDepartmentAccess(req.user, req.params.id);
  sendSuccess(res, await findDept(req.params.id));
});

export const createDepartment = asyncHandler(async (req, res) => {
  const dept = await Department.create({ ...req.body, createdBy: req.user._id });
  logAudit(req, 'department.create', 'Department', dept._id, { name: dept.name });
  sendSuccess(res, dept, 'Department created', 201);
});

export const updateDepartment = asyncHandler(async (req, res) => {
  assertDepartmentAccess(req.user, req.params.id);
  const dept = await findDept(req.params.id);

  // An HOD may edit description and contact info only; name/code belong to the University Head.
  if (req.user.role === ROLES.HOD && (req.body.name || req.body.code)) {
    throw ApiError.forbidden('Only the University Head can change the department name or code');
  }
  Object.entries(flatten(req.body)).forEach(([path, value]) => dept.set(path, value));
  await dept.save();
  logAudit(req, 'department.update', 'Department', dept._id, { fields: Object.keys(req.body) });
  sendSuccess(res, dept, 'Department updated');
});

// Archive keeps every record; it only marks the department inactive.
export const setDepartmentStatus = asyncHandler(async (req, res) => {
  const dept = await findDept(req.params.id);
  dept.status = req.body.status;
  dept.archivedAt = req.body.status === DEPARTMENT_STATUS.ARCHIVED ? new Date() : undefined;
  await dept.save();
  logAudit(req, `department.${req.body.status}`, 'Department', dept._id);
  sendSuccess(res, dept, `Department ${req.body.status}`);
});

// Assign the first HOD, or transfer the role to another teacher of the same department.
export const assignHod = asyncHandler(async (req, res) => {
  const dept = await findDept(req.params.id);
  if (dept.status === DEPARTMENT_STATUS.ARCHIVED) throw ApiError.badRequest('Department is archived');

  const candidate = await User.findById(req.body.userId);
  if (!candidate || !candidate.isActive) throw ApiError.notFound('User not found or inactive');
  if (String(candidate.department) !== String(dept._id)) {
    throw ApiError.badRequest('The new HOD must belong to this department');
  }
  if (candidate.role === ROLES.HOD) throw ApiError.conflict('This user is already the HOD');
  if (candidate.role !== ROLES.TEACHER) throw ApiError.badRequest('Only a teacher can be made HOD');

  const now = new Date();
  const previous = dept.hod ? await User.findById(dept.hod._id) : null;

  if (previous) {
    previous.role = ROLES.TEACHER; // outgoing HOD returns to a normal teacher
    await previous.save();
    const open = dept.hodHistory.find((h) => !h.to && String(h.user) === String(previous._id));
    if (open) open.to = now;
  }
  candidate.role = ROLES.HOD;
  await candidate.save();

  dept.hod = candidate._id;
  dept.hodHistory.push({ user: candidate._id, from: now });
  await dept.save();

  logAudit(req, previous ? 'department.hod_transfer' : 'department.hod_assign', 'Department', dept._id, {
    from: previous?._id,
    to: candidate._id,
  });
  sendSuccess(res, await findDept(dept._id), 'HOD assigned');
});
