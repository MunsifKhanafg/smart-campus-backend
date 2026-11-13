import Complaint from '../models/Complaint.js';
import StudentProfile from '../models/StudentProfile.js';
import Department from '../models/Department.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { toFileDocs, sendStored } from '../middleware/upload.js';
import { ROLES, COMPLAINT_STATUS } from '../config/constants.js';

const file = (f) => ({ originalName: f.originalName, storedName: f.storedName, mimeType: f.mimeType, size: f.size });
const shape = (c, extra = {}) => ({
  _id: c._id, category: c.category, recipient: c.recipient, subject: c.subject, description: c.description, status: c.status,
  attachments: c.attachments.map(file), responses: c.responses.map((r) => ({ byRole: r.byRole, message: r.message, status: r.status, at: r.at })),
  resolution: c.resolution, resolvedAt: c.resolvedAt, createdAt: c.createdAt, source: c.source || 'student', ...extra,
});

// Which office may read a complaint? Only the one it was addressed to. Teachers are never one of them.
const canHandle = (user, c) => {
  if (user.role === ROLES.HOD) return c.recipient === 'hod' && String(c.department) === String(user.department);
  if (user.role === ROLES.UNIVERSITY_HEAD) return c.recipient === 'university_head';
  if (user.role === ROLES.FINANCE_OFFICER) return c.recipient === 'finance_officer';
  return false;
};

const handlerIds = async (c) => {
  if (c.recipient === 'hod') return (await Department.findById(c.department).select('hod'))?.hod ? [(await Department.findById(c.department).select('hod')).hod] : [];
  const role = c.recipient === 'university_head' ? ROLES.UNIVERSITY_HEAD : ROLES.FINANCE_OFFICER;
  return User.find({ role, isActive: true }).distinct('_id');
};

// ---------- Student ----------
export const createComplaint = uploadHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile) throw ApiError.notFound('Your student profile has not been created yet');
  if (req.body.relatedCourse) {
    const course = await Course.findById(req.body.relatedCourse).select('department');
    if (!course || String(course.department) !== String(profile.department)) throw ApiError.badRequest('Selected course not found');
  }
  const c = await Complaint.create({ ...req.body, student: req.user._id, department: profile.department, attachments: toFileDocs(req.files || []) });
  await notifyUsers(await handlerIds(c), { title: 'New student complaint', message: c.subject, type: 'complaint', link: '/complaints' });
  logAudit(req, 'complaint.create', 'Complaint', c._id, { category: c.category, recipient: c.recipient });
  sendSuccess(res, shape(c), 'Complaint submitted', 201);
});

export const myComplaints = asyncHandler(async (req, res) => {
  const list = await Complaint.find({ student: req.user._id }).sort({ createdAt: -1 });
  sendSuccess(res, list.map((c) => shape(c)));
});

// ---------- Staff: only complaints addressed to their office ----------
export const listComplaints = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.HOD) Object.assign(filter, { recipient: 'hod', department: req.user.department });
  else if (req.user.role === ROLES.UNIVERSITY_HEAD) filter.recipient = 'university_head';
  else filter.recipient = 'finance_officer';
  if (req.query.status) filter.status = req.query.status;

  const list = await Complaint.find(filter).sort({ createdAt: -1 }).limit(300);
  const ids = list.map((c) => c.student);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name').lean(),
    StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean(),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, list.map((c) => shape(c, { studentName: name.get(String(c.student)), rollNumber: roll.get(String(c.student)) })));
});

export const respond = asyncHandler(async (req, res) => {
  const c = await Complaint.findById(req.params.id);
  if (!c || !canHandle(req.user, c)) throw ApiError.notFound('Complaint not found'); // 404, so its existence is not revealed
  if ([COMPLAINT_STATUS.RESOLVED, COMPLAINT_STATUS.REJECTED].includes(c.status)) throw ApiError.conflict('This complaint is already closed');

  c.responses.push({ by: req.user._id, byRole: req.user.role, message: req.body.message, status: req.body.status });
  c.status = req.body.status;
  if (req.body.status === COMPLAINT_STATUS.RESOLVED) {
    c.resolution = req.body.resolution;
    c.resolvedAt = new Date();
  }
  await c.save();
  await notifyUsers([c.student], { title: `Complaint ${c.status.replace('_', ' ')}`, message: c.subject, type: 'complaint', link: '/complaints' });
  logAudit(req, 'complaint.respond', 'Complaint', c._id, { status: c.status });
  sendSuccess(res, shape(c), 'Response saved');
});

export const downloadAttachment = asyncHandler(async (req, res) => {
  const c = await Complaint.findById(req.params.id);
  const allowed = c && (req.user.role === ROLES.STUDENT ? String(c.student) === String(req.user._id) : canHandle(req.user, c));
  if (!allowed) throw ApiError.notFound('Complaint not found');
  const f = c.attachments.find((a) => a.storedName === req.params.storedName);
  if (!f) throw ApiError.notFound('File not found');
  sendStored(res, 'complaints', f);
});
