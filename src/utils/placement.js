import { ApiError } from './apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { ROLES } from '../config/constants.js';

// Where a Class IV staff member works: in one DEPARTMENT, or in an OFFICE / SECTION that belongs to no department
// (main college, principal's office, controller office, finance office ...). The office is a plain name.
export const OFFICES = [
  'Main College',
  "Principal's Office",
  'Controller Office',
  'Finance Office',
  'Admission Office',
  'Library',
  'Examination Section',
  'Hostel / Mess',
];

// "finance   office" / "FINANCE OFFICE" -> "Finance Office" (a name that already exists keeps its spelling, so one office is never split in two)
export const canonicalOffice = async (name, Model) => {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const known = OFFICES.find((o) => o.toLowerCase() === clean.toLowerCase());
  if (known) return known;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = await Model.findOne({ office: new RegExp(`^${escaped}$`, 'i') }).select('office').lean();
  return existing?.office || clean;
};

// Department staff: the HOD of that department and the principal. Office staff: the principal only.
export const assertPlacementAccess = (user, item) => {
  if (item.department) return assertDepartmentAccess(user, item.department);
  if (user.role !== ROLES.UNIVERSITY_HEAD) throw ApiError.forbidden('Only the principal manages the staff of offices');
  return undefined;
};
