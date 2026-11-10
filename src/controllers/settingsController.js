import fs from 'fs';
import path from 'path';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { flatten } from '../utils/flatten.js';
import { BRANDING_DIR } from '../middleware/upload.js';
import { portalState } from '../services/applicationService.js';
import { detectImageType } from '../utils/imageType.js';

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Older versions kept the logo as a file in uploads/branding. Move such a file into the database the first time it is found.
// If the file is gone (for example the temporary disk of Vercel was wiped) the dead address is cleared, so the page shows the
// default emblem at once instead of a broken image, and the University Head uploads the logo once more (it then stays for good).
const migrateLegacyLogo = async (s) => {
  if (!s.logoUrl || !s.logoUrl.startsWith('/uploads/branding/')) return;
  const file = path.join(BRANDING_DIR, path.basename(s.logoUrl));
  try {
    const buf = await fs.promises.readFile(file);
    const mime = detectImageType(buf) || MIME_BY_EXT[path.extname(file).toLowerCase()];
    if (!mime) throw new Error('not an image');
    s.logoData = buf;
    s.logoMime = mime;
    s.logoUrl = `/api/settings/logo?v=${Date.now()}`;
  } catch {
    s.logoUrl = '';
  }
  try { await s.save(); } catch (err) { console.warn('Could not move the old logo into the database:', err.message); }
};

// Public: the logo picture itself, read from the database. Needs no login (the login page shows it).
export const sendLogo = asyncHandler(async (_req, res) => {
  const s = await UniversitySettings.findOne({ key: 'global' }).select('+logoData logoMime');
  if (!s?.logoData?.length) throw ApiError.notFound('No logo has been uploaded');
  res.set({
    'Content-Type': s.logoMime || 'image/png',
    // The address carries ?v=<time>, so a new logo gets a new address and the old one can be cached for a long time.
    'Cache-Control': 'public, max-age=604800',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(s.logoData);
});

// Public: only branding/contact fields. Safe to show on the login page.
export const getPublicSettings = asyncHandler(async (_req, res) => {
  const s = await UniversitySettings.getSettings();
  await migrateLegacyLogo(s);
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
  // What the file really is comes from its first bytes, not from its name or the type the browser reports.
  const mime = detectImageType(req.file.buffer);
  if (!mime) throw ApiError.badRequest('This file is not a valid PNG, JPG or WEBP image');

  const s = await UniversitySettings.getSettings();
  // Remove an old logo FILE if there still is one (only inside our branding folder).
  if (s.logoUrl?.startsWith('/uploads/branding/')) {
    fs.promises.unlink(path.join(BRANDING_DIR, path.basename(s.logoUrl))).catch(() => {});
  }
  s.logoData = req.file.buffer;
  s.logoMime = mime;
  s.logoUrl = `/api/settings/logo?v=${Date.now()}`;
  s.updatedBy = req.user._id;
  await s.save();
  logAudit(req, 'settings.logo', 'UniversitySettings', s._id);
  sendSuccess(res, { logoUrl: s.logoUrl }, 'Logo updated');
});
