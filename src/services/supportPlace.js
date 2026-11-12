import { ROLES } from '../config/constants.js';

// ============================================================================================================
// WHERE a Class IV (support) staff member works.
//
// One place only, either
//   - a DEPARTMENT: the HOD of that department keeps the list, the principal sees it too, or
//   - an OFFICE that belongs to no department: main college, principal's office, controller of examinations office, finance office,
//     library, hostel ... Only the principal keeps those lists (an HOD has no access to them).
//
// The list filter and the duties use the same rule, so it lives here once.
// ============================================================================================================

// The offices offered in the "Place of duty" box. The field itself is free text, so any other place can be typed.
export const OFFICE_SUGGESTIONS = [
  'Main college',
  "Principal's office",
  'Controller of examinations office',
  'Finance office',
  'Admission office',
  'Library',
  'Hostel',
  'Transport',
  'Mosque / prayer hall',
];

// Query value that means "every office, whatever its name" (staff that belong to no department).
export const ALL_OFFICES = '__offices__';

// The database filter for a list. An HOD is always locked to their own department; the principal may choose.
export const placeFilter = (user, query = {}) => {
  if (user.role === ROLES.HOD) return { department: user.department };
  if (query.department) return { department: query.department };
  if (query.office === ALL_OFFICES) return { department: null };
  if (query.office) return { department: null, office: query.office };
  return {};
};
