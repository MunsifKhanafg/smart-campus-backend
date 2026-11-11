import multer from 'multer';
import User from '../models/User.js';
import UserPhoto from '../models/UserPhoto.js';
import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { teachesIn } from '../services/teacherService.js';
import { ROLES } from '../config/constants.js';

// ============================================================================================================
// Profiles: the photo and the education / professional details of every person.
//
//   WHO CAN CHANGE a profile or photo:   the person themselves, the University Head (anybody), an HOD (the teachers and the students of
//                                        their own department).
//   WHO CAN SEE the photo:               a teacher / HOD / principal / finance officer photo: everybody who is logged in.
//                                        a STUDENT photo: the student, the principal, the finance office, the HOD of the department and
//                                        the teachers of the courses the student is enrolled in. Nobody else.
//   WHO CAN SEE the details:             education, degrees, experience and designation: everybody who is logged in (like a faculty page).
//                                        personal details (date of birth, address, gender): only those who can change the profile.
// ============================================================================================================

const sameId = (a, b) => String(a?._id || a) === String(b?._id || b);
const PERSONAL = ['dateOfBirth', 'address', 'city', 'gender', 'joiningDate'];

const canManage = (viewer, target) => {
  if (sameId(viewer._id, target._id)) return true;
  if (viewer.role === ROLES.UNIVERSITY_HEAD) return true;
  // An HOD manages the people whose HOME department is theirs.
  return viewer.role === ROLES.HOD && !!viewer.department && sameId(target.department, viewer.department) && [ROLES.TEACHER, ROLES.STUDENT].includes(target.role);
};

const canViewPhoto = async (viewer, target) => {
  if (sameId(viewer._id, target._id)) return true;
  if (target.role !== ROLES.STUDENT) return true; // staff photos are visible to every logged-in user
  if ([ROLES.UNIVERSITY_HEAD, ROLES.FINANCE_OFFICER].includes(viewer.role)) return true;
  if (viewer.role === ROLES.HOD) return sameId(target.department, viewer.department);
  if (viewer.role === ROLES.TEACHER) {
    const taught = await Course.find({ teacher: viewer._id }).distinct('_id');
    return !!(await CourseEnrollment.exists({ student: target._id, course: { $in: taught } }));
  }
  return false;
};

const loadTarget = async (id, select = '') => {
  const user = await User.findById(id).select(select);
  if (!user) throw ApiError.notFound('Person not found');
  return user;
};

// ---------- details ----------
export const getProfile = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id).select('+profile').populate('department', 'name code').populate('extraDepartments', 'name code');
  if (!target) throw ApiError.notFound('Person not found');
  if (target.role === ROLES.STUDENT && !(await canViewPhoto(req.user, target))) throw ApiError.forbidden('You cannot view this student');

  const manage = canManage(req.user, target);
  const raw = target.profile ? target.profile.toObject() : {};
  const profile = { ...raw };
  if (!manage) PERSONAL.forEach((k) => delete profile[k]);

  const sees = manage || [ROLES.UNIVERSITY_HEAD, ROLES.HOD, ROLES.FINANCE_OFFICER].includes(req.user.role);
  sendSuccess(res, {
    user: {
      _id: target._id, name: target.name, role: target.role, department: target.department, extraDepartments: target.extraDepartments,
      allDepartments: target.allDepartments, qualification: target.qualification, subjects: target.subjects,
      email: sees ? target.email : undefined, phone: sees ? target.phone : undefined,
      hasPhoto: target.hasPhoto, photoUpdatedAt: target.photoUpdatedAt,
    },
    profile,
    canEdit: manage && target.role !== ROLES.STUDENT, // students' details are kept on the Students page
    canChangePhoto: manage,
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const target = await loadTarget(req.params.id, '+profile');
  if (target.role === ROLES.STUDENT) throw ApiError.badRequest("A student's details are edited on the Students page");
  if (!canManage(req.user, target)) throw ApiError.forbidden('You can only change your own profile, or the profile of a teacher of your department');

  const next = target.profile ? target.profile.toObject() : {};
  for (const [key, value] of Object.entries(req.body)) {
    next[key] = value === '' && ['dateOfBirth', 'joiningDate'].includes(key) ? undefined : value;
  }
  target.profile = next;
  await target.save();
  logAudit(req, 'profile.update', 'User', target._id, { fields: Object.keys(req.body) });
  sendSuccess(res, { profile: target.profile }, 'Profile saved');
});

// ---------- photo ----------
// The page shrinks the picture to about 320 x 320 pixels before sending it, so this limit is generous.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(ApiError.badRequest('The photo must be a JPEG, PNG or WebP image'))),
}).single('photo');

export const photoUpload = (req, res, next) =>
  upload(req, res, (err) => {
    if (!err) return next();
    next(err.code === 'LIMIT_FILE_SIZE' ? ApiError.badRequest('The photo is too big (300 KB at most). The page normally shrinks it for you') : err);
  });

// What the bytes really are, not what the browser claimed.
const detectType = (b) => {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
};

export const uploadPhoto = asyncHandler(async (req, res) => {
  const target = await loadTarget(req.params.id);
  if (!canManage(req.user, target)) throw ApiError.forbidden('You cannot change this photo');
  if (!req.file) throw ApiError.badRequest('Choose a photo first');
  const type = detectType(req.file.buffer);
  if (!type) throw ApiError.badRequest('That file is not a valid JPEG, PNG or WebP image');

  await UserPhoto.findOneAndUpdate({ user: target._id }, { contentType: type, data: req.file.buffer, size: req.file.size }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const photoUpdatedAt = new Date();
  await User.updateOne({ _id: target._id }, { hasPhoto: true, photoUpdatedAt });
  logAudit(req, 'profile.photo_set', 'User', target._id);
  sendSuccess(res, { hasPhoto: true, photoUpdatedAt }, 'Photo saved');
});

export const removePhoto = asyncHandler(async (req, res) => {
  const target = await loadTarget(req.params.id);
  if (!canManage(req.user, target)) throw ApiError.forbidden('You cannot change this photo');
  await UserPhoto.deleteOne({ user: target._id });
  await User.updateOne({ _id: target._id }, { hasPhoto: false, photoUpdatedAt: new Date() });
  logAudit(req, 'profile.photo_remove', 'User', target._id);
  sendSuccess(res, { hasPhoto: false }, 'Photo removed');
});

// The picture itself. An <img> tag cannot send the login token, so the website downloads it with the token and shows it from memory.
export const getPhoto = asyncHandler(async (req, res) => {
  const target = await loadTarget(req.params.id, 'role department hasPhoto');
  if (!(await canViewPhoto(req.user, target))) throw ApiError.forbidden('You cannot view this photo');
  const photo = await UserPhoto.findOne({ user: target._id });
  if (!photo) throw ApiError.notFound('No photo');
  res.set({ 'Content-Type': photo.contentType, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.send(photo.data);
});
