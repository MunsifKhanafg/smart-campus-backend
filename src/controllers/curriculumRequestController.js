import Program from '../models/Program.js';
import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import Department from '../models/Department.js';
import CurriculumRequest from '../models/CurriculumRequest.js';
import CurriculumImport from '../models/CurriculumImport.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { findBlockers } from '../utils/blockers.js';
import { syncProgramClasses } from '../services/classService.js';
import { courseBlockerChecks, purgeCourse } from '../services/courseRemoval.js';
import { ROLES } from '../config/constants.js';

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countSubjects = (p) => p.semesters.reduce((n, s) => n + s.subjects.length, 0);

// ===========================================================================================================
// The principal never changes the curriculum directly. "Approve & save" and "Delete" create a REQUEST for the HOD
// of the department. The change is applied only when the HOD approves; a rejection keeps everything as it is.
// ===========================================================================================================

// Which classes made from a programme can be removed (no real records) and which must stay.
const inspectProgramClasses = async (program) => {
  const courses = await Course.find({ program: program._id }).select('code title section semester').populate('semester', 'name').lean();
  const removable = [];
  const kept = [];
  for (const c of courses) {
    const blockers = await findBlockers(courseBlockerChecks(c));
    if (blockers.length) kept.push({ code: c.code, semester: c.semester?.name, because: blockers.map(([n, label]) => `${n} ${label}`).join(', ') });
    else removable.push(c);
  }
  const students = removable.length ? (await CourseEnrollment.distinct('student', { course: { $in: removable.map((c) => c._id) } })).length : 0;
  return { total: courses.length, removable, kept, students };
};

// ---------- applying (runs only after the HOD approved) ----------
const applyAdd = async (r) => {
  const by = r.requestedBy?._id || r.requestedBy; // the principal who asked (requestedBy is populated when loaded for a decision)
  const p = r.snapshot;
  const semesters = (p.semesters || []).filter((s) => s.subjects?.length);
  const existing = await Program.findOne({ department: p.department, name: new RegExp(`^${escapeRx(p.name)}$`, 'i') });
  if (existing) {
    existing.name = p.name;
    existing.semesters = semesters;
    existing.status = 'active';
    existing.sourceImport = r.import || existing.sourceImport;
    await existing.save();
    // Classes made from the old version are brought in line (classes with real records are always kept).
    const classes = await syncProgramClasses(existing, by);
    return { replaced: true, subjects: countSubjects(p), classes: { removed: classes.removed, created: classes.created, notOffered: classes.notOffered, kept: classes.kept } };
  }
  await Program.create({ name: p.name, department: p.department, semesters, sourceImport: r.import || undefined, createdBy: by });
  return { replaced: false, subjects: countSubjects(p) };
};

const applyDelete = async (r) => {
  const program = await Program.findById(r.program);
  if (!program) return { alreadyGone: true };
  let removed = 0;
  let kept = [];
  if (r.deleteMode === 'remove') {
    const found = await inspectProgramClasses(program);
    for (const c of found.removable) { await purgeCourse(c); removed += 1; }
    kept = found.kept;
  }
  const detached = await Course.updateMany({ program: program._id }, { program: null }); // whatever is left no longer points at a deleted programme
  await program.deleteOne();
  return { removed, kept, unlinked: detached.modifiedCount };
};

// ---------- creating requests (called by the principal's actions) ----------
const hodOf = async (departmentIds) => {
  const depts = await Department.find({ _id: { $in: departmentIds } }).select('name hod').lean();
  const missing = depts.filter((d) => !d.hod);
  if (missing.length) throw ApiError.badRequest(`${missing.map((d) => d.name).join(', ')} has no HOD yet. Assign an HOD first, because the HOD must approve curriculum changes`);
  return new Map(depts.map((d) => [String(d._id), d]));
};

// plain = the reviewed programmes of an import (every programme already has a department and subjects).
export const submitAddRequests = async ({ plain, importId, message, user }) => {
  const depts = await hodOf([...new Set(plain.map((p) => String(p.department)))]);
  for (const p of plain) {
    const dup = await CurriculumRequest.findOne({ type: 'add', department: p.department, programName: new RegExp(`^${escapeRx(p.name)}$`, 'i'), status: 'pending' });
    if (dup) throw ApiError.conflict(`"${p.name}" is already waiting for the HOD's approval. Cancel that request first if you want to send a new one`);
  }
  const made = [];
  for (const p of plain) {
    const existing = await Program.findOne({ department: p.department, name: new RegExp(`^${escapeRx(p.name)}$`, 'i') }).select('_id');
    const r = await CurriculumRequest.create({
      type: 'add',
      department: p.department,
      programName: p.name,
      snapshot: { name: p.name, department: p.department, semesters: p.semesters.filter((s) => s.subjects.length) },
      import: importId,
      summary: { semesters: p.semesters.length, subjects: countSubjects(p), replacesExisting: !!existing },
      requestedBy: user._id,
      requestMessage: message,
    });
    made.push(r);
    await notifyUsers([depts.get(String(p.department)).hod], {
      title: `Curriculum approval needed: ${p.name}`,
      message: `${user.name} wants to ${existing ? 'replace' : 'add'} this curriculum (${countSubjects(p)} subjects). Message: ${message}`,
      type: 'curriculum',
      link: '/curriculum',
    });
  }
  return made;
};

export const submitDeleteRequest = async ({ program, mode, message, user }) => {
  const depts = await hodOf([program.department]);
  if (await CurriculumRequest.exists({ type: 'delete', program: program._id, status: 'pending' })) {
    throw ApiError.conflict('A request to delete this programme is already waiting for the HOD');
  }
  const found = await inspectProgramClasses(program);
  const r = await CurriculumRequest.create({
    type: 'delete',
    department: program.department,
    programName: program.name,
    program: program._id,
    deleteMode: mode,
    summary: { subjects: countSubjects(program), classes: found.total, removable: mode === 'remove' ? found.removable.length : 0, students: mode === 'remove' ? found.students : 0, kept: found.kept },
    requestedBy: user._id,
    requestMessage: message,
  });
  await notifyUsers([depts.get(String(program.department)).hod], {
    title: `Curriculum deletion needs your approval: ${program.name}`,
    message: `${user.name} wants to delete this curriculum. Message: ${message}`,
    type: 'curriculum',
    link: '/curriculum',
  });
  return r;
};

// ---------- reading ----------
const populate = (q) => q.populate('department', 'name code').populate('requestedBy', 'name').populate('decidedBy', 'name');

const loadFor = async (user, id) => {
  const r = await populate(CurriculumRequest.findById(id));
  if (!r) throw ApiError.notFound('Request not found');
  const dept = String(r.department?._id || r.department);
  if (user.role === ROLES.HOD && dept !== String(user.department)) throw ApiError.notFound('Request not found');
  return r;
};

// Principal: every request. HOD: the requests of their own department. (The long programme text is left out of the list.)
export const listRequests = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  if (req.query.status) filter.status = req.query.status;
  const list = await populate(CurriculumRequest.find(filter).select('-snapshot')).sort({ createdAt: -1 }).limit(100).lean();
  sendSuccess(res, list);
});

export const getRequest = asyncHandler(async (req, res) => sendSuccess(res, await loadFor(req.user, req.params.id)));

// After a rejection or cancellation the principal must be able to fix the draft and send it again. The draft is reopened only when
// none of its programmes is still waiting or was already approved (otherwise sending it again would replace saved work).
const reopenImport = async (importId) => {
  if (!importId) return;
  const busy = await CurriculumRequest.exists({ import: importId, status: { $in: ['pending', 'approved'] } });
  if (!busy) await CurriculumImport.updateOne({ _id: importId, status: 'approved' }, { status: 'review' });
};

// ---------- the HOD decides ----------
export const decideRequest = asyncHandler(async (req, res) => {
  const { decision } = req.body;
  const message = (req.body.message || '').trim();
  const r = await loadFor(req.user, req.params.id); // 404 when it belongs to another department
  if (r.status !== 'pending') throw ApiError.conflict(`This request is already ${r.status}`);
  if (decision === 'reject' && message.length < 3) throw ApiError.badRequest('Please write a message explaining why you reject it');

  // Claim the request first, so a double click (or two browser tabs) can never apply the change twice.
  const claimed = await CurriculumRequest.findOneAndUpdate(
    { _id: r._id, status: 'pending' },
    { status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: req.user._id, decidedAt: new Date(), decisionMessage: message },
    { new: true }
  );
  if (!claimed) throw ApiError.conflict('This request was just decided by someone else');

  let result = null;
  if (decision === 'approve') {
    try {
      result = r.type === 'add' ? await applyAdd(r) : await applyDelete(r);
    } catch (err) {
      await CurriculumRequest.updateOne({ _id: r._id }, { status: 'pending', decidedBy: null, decidedAt: null, decisionMessage: '' }); // nothing was changed: let the HOD try again
      throw err;
    }
    await CurriculumRequest.updateOne({ _id: r._id }, { result });
  }

  const verb = r.type === 'add' ? 'adding' : 'deleting';
  if (decision === 'reject') await reopenImport(r.import);
  await notifyUsers([r.requestedBy._id], {
    title: `${req.user.name} ${decision === 'approve' ? 'approved' : 'rejected'} ${verb} ${r.programName}`,
    message: message || (decision === 'approve' ? 'No message.' : ''),
    type: 'curriculum',
    link: '/curriculum',
  });
  logAudit(req, `curriculum.request_${decision === 'approve' ? 'approved' : 'rejected'}`, 'CurriculumRequest', r._id, { type: r.type, program: r.programName });
  sendSuccess(res, { status: claimed.status, result }, decision === 'approve' ? (r.type === 'add' ? 'Approved. The curriculum is now saved' : 'Approved. The curriculum was deleted') : 'Rejected. Nothing was changed');
});

// The principal withdraws a request that is still waiting.
export const cancelRequest = asyncHandler(async (req, res) => {
  const done = await CurriculumRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { status: 'cancelled', decidedBy: req.user._id, decidedAt: new Date() }, { new: true });
  if (!done) throw ApiError.conflict('Only a request that is still waiting can be cancelled');
  await reopenImport(done.import);
  logAudit(req, 'curriculum.request_cancelled', 'CurriculumRequest', done._id, { program: done.programName });
  sendSuccess(res, done, 'Request cancelled');
});

// Which programmes currently have a deletion waiting (the Programmes tab shows it and disables Delete).
export const pendingByProgram = asyncHandler(async (req, res) => {
  const filter = { status: 'pending', type: 'delete' };
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  const rows = await CurriculumRequest.find(filter).select('program').lean();
  sendSuccess(res, rows.map((x) => String(x.program)));
});
