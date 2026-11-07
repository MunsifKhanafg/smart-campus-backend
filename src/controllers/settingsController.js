import fs from 'fs';
import path from 'path';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { flatten } from '../utils/flatten.js';
import { BRANDING_DIR } from '../middleware/upload.js';
import { portalState } from '../services/applicationService.js';

// Public: only branding/contact fields. Safe to show on the login page.
export const getPublicSettings = asyncHandler(async (_req, res) => {
  const s = await UniversitySettings.getSettings();
  sendSuccess(res, {
    universityName: s.universityName,
    campusName: s.campusName,
    logoUrl: s.logoUrl,
    address: s.address,
    contactNumber: s.contactNumber,
    email: s.email,
    website: s.website,
    officeHours: s.officeHours,
    currentAcademicYear: s.currentAcademicYear,
    // Whether admissions are open, the opening and closing dates and the external link (if any). Used by Home and Login.
    admissionPortal: portalState(s),
  });
});

export const getSettings = asyncHandler(async (_req, res) => {
  sendSuccess(res, await UniversitySettings.getSettings());
});

export const updateSettings = asyncHandler(async (req, res) => {
  const s = await UniversitySettings.getSettings();
  Object.entries(flatten(req.body)).forEach(([p, v]) => s.set(p, v));
  s.updatedBy = req.user._id;
  await s.save();
  logAudit(req, 'settings.update', 'UniversitySettings', s._id, { fields: Object.keys(req.body) });
  sendSuccess(res, s, 'Settings updated');
});

export const uploadLogoFile = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Please choose a logo image');
  const s = await UniversitySettings.getSettings();

  // Remove the previous logo file (only inside our branding folder).
  if (s.logoUrl) {
    fs.promises.unlink(path.join(BRANDING_DIR, path.basename(s.logoUrl))).catch(() => {});
  }
  s.logoUrl = `/uploads/branding/${req.file.filename}`;
  s.updatedBy = req.user._id;
  await s.save();
  logAudit(req, 'settings.logo', 'UniversitySettings', s._id);
  sendSuccess(res, { logoUrl: s.logoUrl }, 'Logo updated');
});
