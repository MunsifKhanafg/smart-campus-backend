import Announcement from '../models/Announcement.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { deliverAnnouncement } from '../services/announcementService.js';
import { ROLES, DEPARTMENT_STATUS } from '../config/constants.js';

// Everyone: announcements already published that are addressed to them.
export const listMine = asyncHandler(async (req, res) => {
  const u = req.user;
  const now = new Date();
  let filter = { publishDate: { $lte: now } };
  if (u.role !== ROLES.UNIVERSITY_HEAD) {
    const audience = [{ scope: 'all' }, { scope: 'users', recipients: u._id }];
    if (u.department) audience.push({ scope: 'departments', departments: u.department });
    filter = { ...filter, $and: [{ $or: audience }, { $or: [{ roles: { $size: 0 } }, { roles: u.role }] }] };
  }
  const list = await Announcement.find(filter).sort({ publishDate: -1 }).limit(100).populate('createdBy', 'name').lean();
  sendSuccess(res, list.map((a) => ({ ...a, createdBy: a.createdBy?.name, recipients: undefined })));
});

// Head and HOD: what they have sent (including scheduled ones).
export const listManaged = asyncHandler(async (req, res) => {
  const filter = req.user.role === ROLES.UNIVERSITY_HEAD ? {} : { createdBy: req.user._id };
  const list = await Announcement.find(filter).sort({ publishDate: -1 }).limit(100).populate('departments', 'name code').lean();
  sendSuccess(res, list);
});

export const createAnnouncement = asyncHandler(async (req, res) => {
  const isHead = req.user.role === ROLES.UNIVERSITY_HEAD;
  const body = { ...req.body };

  if (!isHead) {
    // An HOD may only write to their own department (never to the whole university or to individuals elsewhere).
    if (body.scope !== 'departments' || body.departments.length !== 1 || String(body.departments[0]) !== String(req.user.department)) {
      if (body.scope === 'users') {
        const found = await User.find({ _id: { $in: body.recipients }, department: req.user.department }).select('_id');
        if (found.length !== new Set(body.recipients.map(String)).size) throw ApiError.forbidden('You can only write to people of your own department');
      } else {
        throw ApiError.forbidden('You can only send announcements to your own department');
      }
    }
    body.isPublic = false;
  } else if (body.scope === 'departments') {
    const count = await Department.countDocuments({ _id: { $in: body.departments }, status: DEPARTMENT_STATUS.ACTIVE });
    if (count !== new Set(body.departments.map(String)).size) throw ApiError.badRequest('A selected department was not found or is not active');
  }

  const a = await Announcement.create({ ...body, publishDate: body.publishDate || new Date(), createdBy: req.user._id, createdByRole: req.user.role });
  const sent = a.publishDate <= new Date() ? await deliverAnnouncement(a) : 0; // future ones are sent by the scheduler
  logAudit(req, 'announcement.create', 'Announcement', a._id, { scope: a.scope, sent });
  sendSuccess(res, a, a.publishDate <= new Date() ? `Announcement sent to ${sent} people` : 'Announcement scheduled', 201);
});

export const deleteAnnouncement = asyncHandler(async (req, res) => {
  const a = await Announcement.findById(req.params.id);
  if (!a) throw ApiError.notFound('Announcement not found');
  if (req.user.role !== ROLES.UNIVERSITY_HEAD && String(a.createdBy) !== String(req.user._id)) throw ApiError.forbidden();
  await a.deleteOne();
  logAudit(req, 'announcement.delete', 'Announcement', a._id);
  sendSuccess(res, null, 'Announcement deleted');
});
