import { ROLES } from '../config/constants.js';
import { ApiError } from './apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';

// The University Head and the Finance Officer work across departments. An HOD is limited to their own.
export const hasUniversityWideAccess = (user) => [ROLES.UNIVERSITY_HEAD, ROLES.FINANCE_OFFICER].includes(user.role);

export const assertWideOrDepartment = (user, departmentId) => {
  if (hasUniversityWideAccess(user)) return;
  if (user.role !== ROLES.HOD) throw ApiError.forbidden();
  assertDepartmentAccess(user, departmentId);
};

// Department filter for list queries: wide roles may pick one, an HOD is always locked to their own.
export const departmentFilterFor = (user, requested) => {
  if (user.role === ROLES.HOD) return user.department;
  return requested || undefined;
};
