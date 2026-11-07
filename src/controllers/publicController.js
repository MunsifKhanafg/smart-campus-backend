import Department from '../models/Department.js';
import Announcement from '../models/Announcement.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { DEPARTMENT_STATUS } from '../config/constants.js';

// Public contact page: university details (from settings), department contacts, and announcements the head marked public.
export const contactInfo = asyncHandler(async (_req, res) => {
  const [s, departments, announcements] = await Promise.all([
    UniversitySettings.getSettings(),
    Department.find({ status: DEPARTMENT_STATUS.ACTIVE }).select('name code contact').sort({ name: 1 }).lean(),
    Announcement.find({ isPublic: true, publishDate: { $lte: new Date() } }).select('title message publishDate meeting').sort({ publishDate: -1 }).limit(10).lean(),
  ]);
  sendSuccess(res, {
    university: { name: s.universityName, campus: s.campusName, address: s.address, contactNumber: s.contactNumber, email: s.email, website: s.website, officeHours: s.officeHours },
    departments,
    announcements,
  });
});
