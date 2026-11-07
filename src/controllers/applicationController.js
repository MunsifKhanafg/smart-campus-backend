import mongoose from 'mongoose';
import Application from '../models/Application.js';
import Department from '../models/Department.js';
import Program from '../models/Program.js';
import Semester from '../models/Semester.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { toFileDocs, sendStored, removeStored } from '../middleware/upload.js';
import { autoEnrollSemester } from '../services/enrollmentService.js';
import {
  APPLICATION_STATUS as ST,
  portalState,
  computeMerit,
  nextApplicationNumber,
  rankByDepartment,
} from '../services/applicationService.js';
import { applySchema, resubmitSchema } from '../validators/applicationSchemas.js';
import { ROLES, DEPARTMENT_STATUS, CLOSED_SEMESTER_STATES } from '../config/constants.js';

const CATEGORY = 'applications';
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');

// The upload middleware runs before the validators, so validation happens here and a failure deletes the saved files.
const parseOrThrow = (schema, data) => {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw ApiError.badRequest('Validation failed', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
};

// Every uploaded file needs a document name, and every required document must be present.
const checkDocuments = (files, labels, required) => {
  if (files.length !== labels.length) throw ApiError.badRequest('Every uploaded file needs a document name');
  const have = new Set(labels.map((l) => l.toLowerCase()));
  const missing = required.filter((d) => !have.has(d.toLowerCase()));
  if (missing.length) throw ApiError.badRequest(`Please upload: ${missing.join(', ')}`);
};

// ============================================================================================
// Public (no login)
// ============================================================================================

// Everything the Apply form needs: whether admissions are open, the document list, departments and their BS programmes.
export const publicOptions = asyncHandler(async (_req, res) => {
  const settings = await UniversitySettings.getSettings();
  const [departments, programs] = await Promise.all([
    Department.find({ status: DEPARTMENT_STATUS.ACTIVE }).select('name code').sort({ name: 1 }).lean(),
    Program.find({ status: 'active' }).select('name department').lean(),
  ]);
  sendSuccess(res, {
    portal: portalState(settings),
    departments: departments.map((d) => ({ ...d, programs: programs.filter((p) => String(p.department) === String(d._id)).map((p) => p.name) })),
  });
});

export const apply = uploadHandler(async (req, res) => {
  const body = parseOrThrow(applySchema, req.body);
  const files = req.files || [];

  const settings = await UniversitySettings.getSettings();
  const portal = portalState(settings);
  if (portal.externalUrl) throw ApiError.badRequest('Applications are taken on the university admission website. Please use the link on the home page');
  if (!portal.open) throw ApiError.forbidden(portal.closedReason || 'Admissions are closed');
  checkDocuments(files, body.labels, portal.requiredDocuments);

  const dept = await Department.findOne({ _id: body.department, status: DEPARTMENT_STATUS.ACTIVE });
  if (!dept) throw ApiError.badRequest('Please choose a department');
  if (body.secondDepartment) {
    if (!(await Department.exists({ _id: body.secondDepartment, status: DEPARTMENT_STATUS.ACTIVE }))) throw ApiError.badRequest('The second choice is not available');
  }
  if (body.program) {
    const programs = await Program.find({ department: dept._id, status: 'active' }).select('name').lean();
    if (programs.length && !programs.some((p) => p.name.toLowerCase() === body.program.toLowerCase())) throw ApiError.badRequest('Please choose a programme from the list');
  }

  const nationalId = digits(body.nationalId);
  const dup = await Application.findOne({
    intake: portal.intakeName,
    status: { $ne: ST.REJECTED },
    $or: [{ email: body.email }, { nationalId }],
  }).select('applicationNumber');
  if (dup) throw ApiError.conflict('An application with this email or CNIC already exists for this intake. Use "Track my application" with your application number');

  const { labels, declaration, ...fields } = body; // eslint-disable-line no-unused-vars
  const application = await Application.create({
    ...fields,
    nationalId,
    secondDepartment: body.secondDepartment || null,
    testMarks: body.testMarks ?? null,
    testTotal: body.testTotal ?? null,
    intake: portal.intakeName,
    applicationNumber: await nextApplicationNumber(),
    meritScore: computeMerit(body),
    documents: toFileDocs(files).map((file, i) => ({ label: labels[i], file })),
    history: [{ status: ST.SUBMITTED, note: 'Application submitted', by: 'applicant' }],
  });

  sendSuccess(res, { applicationNumber: application.applicationNumber, status: application.status, intake: application.intake }, 'Application submitted', 201);
});

// What an applicant may see about their own application. Their documents' files, staff names and internal notes stay private.
const publicView = (a, requiredDocuments, meritVisible = false) => ({
  applicationNumber: a.applicationNumber,
  name: a.name,
  intake: a.intake,
  department: a.department?.name,
  program: a.program,
  status: a.status,
  remarks: a.remarks,
  meritScore: meritVisible ? a.meritScore : null, // the score and rank stay hidden until the merit list is published
  merit: meritVisible && a.merit?.rank != null
    ? {
      rank: a.merit.rank,
      called: !!a.merit.called,
      interview: a.merit.called ? { date: a.merit.interviewDate, time: a.merit.interviewTime, venue: a.merit.venue, message: a.merit.message } : null,
    }
    : null,
  submittedAt: a.createdAt,
  enrolled: !!a.enrolledUser,
  documents: a.documents.map((d) => d.label),
  missingDocuments: requiredDocuments.filter((r) => !a.documents.some((d) => d.label.toLowerCase() === r.toLowerCase())),
  canAddDocuments: a.status === ST.NEEDS_INFO,
  history: a.history.map((h) => ({ status: h.status, note: h.note, at: h.at, by: h.by === 'applicant' ? 'You' : 'Admissions office' })),
});

// The application number alone is guessable (APP-2026-00001, 00002...), so the applicant's email must match too.
// Both "not found" cases return the same message.
const findOwn = async ({ applicationNumber, email }) => {
  const a = await Application.findOne({ applicationNumber, email }).populate('department', 'name');
  if (!a) throw ApiError.notFound('No application was found with this number and email');
  return a;
};

export const track = asyncHandler(async (req, res) => {
  const settings = await UniversitySettings.getSettings();
  const portal = portalState(settings);
  sendSuccess(res, publicView(await findOwn(req.body), portal.requiredDocuments, portal.meritListPublished));
});

// An applicant who was asked for more information uploads the missing documents. The application goes back to review.
export const resubmit = uploadHandler(async (req, res) => {
  const body = parseOrThrow(resubmitSchema, req.body);
  const files = req.files || [];
  if (!files.length) throw ApiError.badRequest('Please choose at least one file');
  if (files.length !== body.labels.length) throw ApiError.badRequest('Every uploaded file needs a document name');

  const a = await findOwn(body);
  if (a.status !== ST.NEEDS_INFO) throw ApiError.conflict('This application is not waiting for more documents');

  // A new file replaces an older one with the same document name (the old file is deleted from disk).
  const replaced = a.documents.filter((d) => body.labels.some((l) => l.toLowerCase() === d.label.toLowerCase()));
  a.documents = a.documents.filter((d) => !replaced.includes(d));
  toFileDocs(files).forEach((file, i) => a.documents.push({ label: body.labels[i], file }));
  a.status = ST.UNDER_REVIEW;
  a.history.push({ status: ST.UNDER_REVIEW, note: `Applicant added: ${body.labels.join(', ')}`, by: 'applicant' });
  await a.save();
  removeStored(CATEGORY, replaced.map((d) => d.file));

  const settings = await UniversitySettings.getSettings();
  const portal = portalState(settings);
  sendSuccess(res, publicView(a, portal.requiredDocuments, portal.meritListPublished), 'Documents received');
});

// Public merit list. Only visible after the University Head publishes it in Settings.
export const meritList = asyncHandler(async (req, res) => {
  const settings = await UniversitySettings.getSettings();
  const portal = portalState(settings);
  if (!portal.meritListPublished) throw ApiError.notFound('The merit list has not been published yet');

  const filter = { intake: portal.intakeName, 'merit.rank': { $ne: null } }; // only applicants ranked when the list was published
  if (req.query.department) filter.department = req.query.department;
  const apps = await Application.find(filter).select('applicationNumber name department program meritScore merit').lean();
  const ranked = apps.map((a) => ({ ...a, rank: a.merit.rank })); // the rank was frozen when the list was published
  const departments = await Department.find({ _id: { $in: [...new Set(apps.map((a) => String(a.department)))] } }).select('name code').sort({ name: 1 }).lean();

  sendSuccess(res, {
    intake: portal.intakeName,
    departments: departments.map((d) => ({
      _id: d._id,
      name: d.name,
      code: d.code,
      rows: ranked
        .filter((r) => String(r.department) === String(d._id))
        .sort((a, b) => a.rank - b.rank || a.applicationNumber.localeCompare(b.applicationNumber))
        .map((r) => ({ rank: r.rank, applicationNumber: r.applicationNumber, name: r.name, program: r.program, meritScore: r.meritScore, selected: !!r.merit?.called })),
    })),
  });
});

// ============================================================================================
// Staff (University Head: all departments, HOD: own department)
// ============================================================================================
const scope = (user) => (user.role === ROLES.UNIVERSITY_HEAD ? {} : { department: user.department });

const loadApplication = async (id, user) => {
  const a = await Application.findById(id).populate('department', 'name code').populate('secondDepartment', 'name code');
  if (!a) throw ApiError.notFound('Application not found');
  assertDepartmentAccess(user, a.department._id);
  return a;
};

export const listApplications = asyncHandler(async (req, res) => {
  const { status, department, search } = req.query;
  const base = scope(req.user);
  if (req.user.role === ROLES.UNIVERSITY_HEAD && department) base.department = department;

  const filter = { ...base };
  if (status) filter.status = status;
  if (search) {
    const rx = new RegExp(escapeRx(search), 'i');
    filter.$or = [{ name: rx }, { applicationNumber: rx }, { email: rx }, { nationalId: rx }];
  }

  const [rows, rankBase, counts] = await Promise.all([
    Application.find(filter).populate('department', 'name code').sort({ department: 1, meritScore: -1, createdAt: 1 }).limit(1000).lean(),
    // Rank among every applicant who is still in the race, even when the list is filtered.
    Application.find({ ...base, status: { $ne: ST.REJECTED } }).select('department meritScore createdAt').lean(),
    Application.aggregate([
      ...(base.department ? [{ $match: { department: new mongoose.Types.ObjectId(String(base.department)) } }] : []),
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
  ]);
  const rank = new Map(rankByDepartment(rankBase).map((r) => [String(r._id), r.rank]));
  const summary = Object.fromEntries(Object.values(ST).map((s) => [s, 0]));
  counts.forEach((c) => { summary[c._id] = c.n; });

  sendSuccess(res, {
    summary: { ...summary, total: Object.values(summary).reduce((a, b) => a + b, 0) },
    rows: rows.map((a) => ({ ...a, rank: rank.get(String(a._id)) ?? null })),
  });
});

export const getApplication = asyncHandler(async (req, res) => {
  sendSuccess(res, await loadApplication(req.params.id, req.user));
});

export const reviewApplication = asyncHandler(async (req, res) => {
  const a = await loadApplication(req.params.id, req.user);
  if (a.enrolledUser) throw ApiError.conflict('A student account was already created for this applicant, so the decision cannot change');

  a.status = req.body.status;
  a.remarks = req.body.remarks || '';
  a.reviewedBy = req.user._id;
  a.reviewedAt = new Date();
  a.history.push({ status: a.status, note: a.remarks, by: req.user.name });
  await a.save();

  logAudit(req, `application.${a.status}`, 'Application', a._id, { applicationNumber: a.applicationNumber });
  sendSuccess(res, a, 'Decision saved');
});

// Turns an accepted applicant into a student: a login plus an academic profile, in the HOD's own department.
// The HOD chooses the first password and gives it to the student in person. The student must change it at the first login.
export const enrollApplicant = asyncHandler(async (req, res) => {
  const a = await loadApplication(req.params.id, req.user);
  if (a.status !== ST.ACCEPTED) throw ApiError.badRequest('Only an accepted application can become a student');
  if (a.enrolledUser) throw ApiError.conflict('A student account was already created for this applicant');

  let semester = null;
  if (req.body.semester) {
    semester = await Semester.findById(req.body.semester);
    if (!semester || String(semester.department) !== String(a.department._id)) throw ApiError.badRequest('Semester must belong to the same department');
    if (CLOSED_SEMESTER_STATES.includes(semester.status)) throw ApiError.badRequest(`The semester is ${semester.status}`);
  }

  const user = await User.create({
    name: a.name,
    email: a.email,
    password: req.body.password,
    phone: a.phone,
    role: ROLES.STUDENT,
    department: a.department._id,
    mustChangePassword: true,
  });
  let profile;
  try {
    profile = await StudentProfile.create({
      user: user._id,
      rollNumber: req.body.rollNumber,
      department: a.department._id,
      semester: semester?._id || null,
      section: req.body.section || 'A',
      admissionYear: new Date(a.createdAt).getUTCFullYear(),
      dateOfBirth: a.dateOfBirth,
      guardianName: a.fatherName,
      address: a.address,
      createdBy: req.user._id,
    });
  } catch (err) {
    await User.deleteOne({ _id: user._id }); // never leave a login without a profile (for example a duplicate roll number)
    throw err;
  }
  if (semester) await autoEnrollSemester([profile], semester._id, req.user._id);

  a.enrolledUser = user._id;
  a.history.push({ status: ST.ACCEPTED, note: `Student account created (roll number ${profile.rollNumber})`, by: req.user.name });
  await a.save();

  logAudit(req, 'application.enroll', 'Application', a._id, { rollNumber: profile.rollNumber });
  sendSuccess(res, { studentId: user._id, rollNumber: profile.rollNumber, email: user.email }, 'Student account created', 201);
});

export const downloadDocument = asyncHandler(async (req, res) => {
  const a = await loadApplication(req.params.id, req.user);
  const doc = a.documents.find((d) => d.file.storedName === req.params.storedName);
  if (!doc) throw ApiError.notFound('File not found');
  sendStored(res, CATEGORY, doc.file);
});

// Names used by routes/applications.js
export const getPortal = publicOptions;
export const submitApplication = apply;
export const trackApplication = track;
export const publicMeritList = meritList;
export const downloadApplicationFile = downloadDocument;
