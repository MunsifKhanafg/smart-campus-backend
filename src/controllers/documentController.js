import StudentDocument from '../models/StudentDocument.js';
import StudentProfile from '../models/StudentProfile.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { toFileDocs, sendStored } from '../middleware/upload.js';
import { ROLES, REVIEW_STATUS } from '../config/constants.js';

const MAX_DOCUMENTS_PER_STUDENT = 40;

const shape = (d) => ({
  _id: d._id, type: d.type, note: d.note, status: d.status, remarks: d.remarks, createdAt: d.createdAt, reviewedAt: d.reviewedAt,
  files: d.files.map((f) => ({ originalName: f.originalName, storedName: f.storedName, mimeType: f.mimeType, size: f.size })),
});

export const uploadDocument = uploadHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id });
  if (!profile) throw ApiError.notFound('Your student profile has not been created yet');
  if (!req.files?.length) throw ApiError.badRequest('Please attach at least one file');
  // Storage guard: one student cannot fill the disk. (uploadHandler deletes the files if we throw here.)
  if ((await StudentDocument.countDocuments({ student: req.user._id })) >= MAX_DOCUMENTS_PER_STUDENT) {
    throw ApiError.badRequest(`You have reached the limit of ${MAX_DOCUMENTS_PER_STUDENT} uploaded documents. Please contact your department`);
  }
  const doc = await StudentDocument.create({
    student: req.user._id,
    department: profile.department,
    type: req.body.type,
    note: req.body.note || '',
    files: toFileDocs(req.files),
  });
  logAudit(req, 'document.upload', 'StudentDocument', doc._id, { type: doc.type });
  sendSuccess(res, shape(doc), 'Document uploaded. Staff will review it', 201);
});

export const myDocuments = asyncHandler(async (req, res) => {
  const docs = await StudentDocument.find({ student: req.user._id }).sort({ createdAt: -1 });
  sendSuccess(res, docs.map(shape));
});

// HOD (own department) or head: documents waiting for review.
export const listDocuments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  if (req.query.status) filter.status = req.query.status;
  const docs = await StudentDocument.find(filter).sort({ createdAt: -1 }).limit(300);
  const ids = docs.map((d) => d.student);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name').lean(),
    StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean(),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  sendSuccess(res, docs.map((d) => ({ ...shape(d), studentName: name.get(String(d.student)), rollNumber: roll.get(String(d.student)) })));
});

export const reviewDocument = asyncHandler(async (req, res) => {
  const doc = await StudentDocument.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Document not found');
  assertDepartmentAccess(req.user, doc.department);
  doc.status = req.body.status;
  doc.remarks = req.body.remarks || '';
  doc.reviewedBy = req.user._id;
  doc.reviewedAt = new Date();
  await doc.save();
  await notifyUsers([doc.student], { title: `Document ${doc.status.replace('_', ' ')}: ${doc.type}`, message: doc.remarks, type: 'document', link: '/documents' });
  logAudit(req, 'document.review', 'StudentDocument', doc._id, { status: doc.status });
  sendSuccess(res, shape(doc), 'Review saved');
});

export const downloadDocumentFile = asyncHandler(async (req, res) => {
  const doc = await StudentDocument.findById(req.params.id);
  if (!doc) throw ApiError.notFound('Document not found');
  if (req.user.role === ROLES.STUDENT) {
    if (String(doc.student) !== String(req.user._id)) throw ApiError.forbidden();
  } else {
    assertDepartmentAccess(req.user, doc.department);
  }
  const file = doc.files.find((f) => f.storedName === req.params.storedName);
  if (!file) throw ApiError.notFound('File not found');
  sendStored(res, 'documents', file);
});
