import multer from 'multer';
import SupportStaff from '../models/SupportStaff.js';
import SupportDuty from '../models/SupportDuty.js';
import Department from '../models/Department.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { assertPlacementAccess, canonicalOffice } from '../utils/placement.js';
import { sniffImage, MAX_PHOTO_BYTES } from '../services/imageSniff.js';
import { formatCnic } from '../validators/supportStaffSchemas.js';
import { ROLES, DEPARTMENT_STATUS } from '../config/constants.js';

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const loadStaff = async (id, user, select = '') => {
  const staff = await SupportStaff.findById(id).select(select);
  if (!staff) throw ApiError.notFound('Staff member not found');
  assertPlacementAccess(user, staff); // an HOD only reaches their own department's staff; office staff belong to the principal
  return staff;
};

// The principal sees every department and office (or one place); an HOD always only their own department.
export const listStaff = asyncHandler(async (req, res) => {
  const { status, search, department, office } = req.query;
  const filter = {};
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  else if (department) filter.department = department;
  else if (office) filter.office = office;
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRx(search), 'i');
    filter.$or = [{ name: rx }, { designation: rx }, { phone: rx }, { cnic: rx }, { duty: rx }, { office: rx }];
  }
  const staff = await SupportStaff.find(filter).populate('department', 'name code').sort({ name: 1 }).lean();
  sendSuccess(res, staff);
});

export const getStaff = asyncHandler(async (req, res) => {
  const staff = await loadStaff(req.params.id, req.user);
  await staff.populate('department', 'name code');
  sendSuccess(res, staff);
});

export const createStaff = asyncHandler(async (req, res) => {
  const { department: bodyDept, office: bodyOffice, ...rest } = req.body;
  if (rest.cnic) rest.cnic = formatCnic(rest.cnic);
  const place = {};

  if (req.user.role === ROLES.HOD) {
    // An HOD only adds to their own department, whatever the request says.
    if (!req.user.department) throw ApiError.badRequest('No department is assigned to your account');
    place.department = req.user.department;
  } else if (bodyDept && bodyOffice) {
    throw ApiError.badRequest('Choose a department or an office, not both');
  } else if (bodyDept) {
    place.department = bodyDept;
  } else if (bodyOffice) {
    place.office = await canonicalOffice(bodyOffice, SupportStaff);
  } else {
    throw ApiError.badRequest('Choose the department or the office of this staff member');
  }

  let label = place.office;
  if (place.department) {
    const dept = await Department.findById(place.department);
    if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Department not found or not active');
    label = dept.code;
  }
  const staff = await SupportStaff.create({ ...rest, ...place, createdBy: req.user._id });
  logAudit(req, 'support_staff.create', 'SupportStaff', staff._id, { name: staff.name, designation: staff.designation, place: label });
  sendSuccess(res, staff, 'Staff member added', 201);
});

export const updateStaff = asyncHandler(async (req, res) => {
  const staff = await loadStaff(req.params.id, req.user);
  const body = { ...req.body };
  if (body.cnic) body.cnic = formatCnic(body.cnic);
  staff.set(body);
  await staff.save();
  logAudit(req, 'support_staff.update', 'SupportStaff', staff._id, { fields: Object.keys(req.body) });
  sendSuccess(res, staff, 'Staff member updated');
});

// A staff member is a directory entry. Their assigned duties go with them; to keep the history, set the status to "inactive" instead.
export const deleteStaff = asyncHandler(async (req, res) => {
  const staff = await loadStaff(req.params.id, req.user);
  await SupportDuty.deleteMany({ staff: staff._id });
  await staff.deleteOne();
  logAudit(req, 'support_staff.delete', 'SupportStaff', staff._id, { name: staff.name });
  sendSuccess(res, null, 'Staff member deleted');
});

// ---------- photo ----------
// The photo arrives in memory (it is small) and is stored inside the database record, so it survives a server restart on Vercel.
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }).single('photo');
export const photoUpload = (req, res, next) =>
  memory(req, res, (err) => {
    if (!err) return next();
    next(err.code === 'LIMIT_FILE_SIZE' ? ApiError.badRequest('The picture is larger than 300 KB') : ApiError.badRequest(err.message));
  });

export const putPhoto = asyncHandler(async (req, res) => {
  const staff = await loadStaff(req.params.id, req.user);
  if (!req.file) throw ApiError.badRequest('Choose a picture first');
  const contentType = sniffImage(req.file.buffer); // judged by what the bytes really are, not by the file name
  if (!contentType) throw ApiError.badRequest('This file is not a JPG, PNG or WebP picture');
  staff.photo = { contentType, data: req.file.buffer };
  staff.hasPhoto = true;
  staff.photoUpdatedAt = new Date();
  await staff.save();
  logAudit(req, 'support_staff.photo', 'SupportStaff', staff._id);
  sendSuccess(res, { hasPhoto: true, photoUpdatedAt: staff.photoUpdatedAt }, 'Photo saved');
});

export const removePhoto = asyncHandler(async (req, res) => {
  const staff = await loadStaff(req.params.id, req.user);
  const photoUpdatedAt = new Date();
  await SupportStaff.updateOne({ _id: staff._id }, { $unset: { photo: 1 }, $set: { hasPhoto: false, photoUpdatedAt } });
  sendSuccess(res, { hasPhoto: false, photoUpdatedAt }, 'Photo removed');
});

// Sent only to people who may see this staff member. The page downloads it with the login token (see components/Avatar.jsx).
export const getPhoto = asyncHandler(async (req, res) => {
  const staff = await loadStaff(req.params.id, req.user, '+photo.data');
  if (!staff.hasPhoto || !staff.photo?.data) throw ApiError.notFound('No photo');
  res.set('Content-Type', staff.photo.contentType);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(staff.photo.data);
});
