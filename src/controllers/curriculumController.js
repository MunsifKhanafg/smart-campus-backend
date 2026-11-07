import Program from '../models/Program.js';
import CurriculumImport from '../models/CurriculumImport.js';
import Department from '../models/Department.js';
import Course from '../models/Course.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { toFileDocs, removeStored, storedPath } from '../middleware/upload.js';
import { extractText } from '../services/textExtractService.js';
import { extractCurriculum, countSubjects } from '../services/curriculumService.js';
import { syncProgramClasses } from '../services/classService.js';
import { courseBlockerChecks, purgeCourse } from '../services/courseRemoval.js';
import { findBlockers } from '../utils/blockers.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import fs from 'fs';
import { ROLES, DEPARTMENT_STATUS } from '../config/constants.js';

const READABLE = {
  'application/pdf': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true,
  'text/plain': true,
};
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const loadImport = async (id) => {
  const imp = await CurriculumImport.findById(id);
  if (!imp) throw ApiError.notFound('Curriculum import not found');
  return imp;
};

const summary = (imp) => ({
  _id: imp._id,
  fileName: imp.file?.originalName,
  status: imp.status,
  method: imp.method,
  programs: imp.programs.length,
  subjects: countSubjects(imp.programs),
  createdAt: imp.createdAt,
  approvedAt: imp.approvedAt,
});

// Suggests a department from the programme name ("BS Computer Science" -> Computer Science). The reviewer can change it.
const guessDepartment = (programName, departments) => {
  const name = programName.toLowerCase();
  let best = null;
  for (const d of departments) {
    const dn = d.name.toLowerCase().replace(/^(department|dept\.?) of\s+/, '');
    const hit = name.includes(dn) || new RegExp(`\\b${escapeRx(d.code.toLowerCase())}\\b`).test(name);
    if (hit && (!best || dn.length > best.len)) best = { id: d._id, len: dn.length };
  }
  return best?.id || null;
};

// Checks rules that the schema alone cannot (names must be unique, a code cannot repeat inside one semester).
const assertDraftConsistent = (programs) => {
  const names = new Set();
  for (const p of programs) {
    const key = `${p.department || ''}|${p.name.toLowerCase()}`;
    if (names.has(key)) throw ApiError.badRequest(`Two programmes are called "${p.name}"${p.department ? ' in the same department' : ''}. Merge or rename them`);
    names.add(key);
    const semesters = new Set();
    for (const s of p.semesters) {
      if (semesters.has(s.number)) throw ApiError.badRequest(`${p.name}: semester ${s.number} appears twice`);
      semesters.add(s.number);
      const codes = new Set();
      for (const sub of s.subjects) {
        const code = sub.code.toUpperCase();
        if (codes.has(code)) throw ApiError.badRequest(`${p.name}, semester ${s.number}: code ${code} is used twice`);
        codes.add(code);
      }
    }
  }
};

// ---------- Upload and extraction ----------
export const createImport = uploadHandler(async (req, res) => {
  const file = req.files?.[0];
  if (!file) throw ApiError.badRequest('Please choose a curriculum file');
  if (!READABLE[file.mimetype]) throw ApiError.badRequest('Upload a PDF, Word (.docx) or text file');

  const text = (await extractText(storedPath('curriculum', file.filename), file.mimetype)) || '';
  if (text.trim().length < 40) {
    removeStored('curriculum', [{ storedName: file.filename }]);
    throw ApiError.badRequest('No readable text was found in this file. A scanned (image-only) PDF cannot be read. Upload a text-based PDF or a Word file');
  }

  const result = await extractCurriculum(text);
  const departments = await Department.find({ status: DEPARTMENT_STATUS.ACTIVE }).select('name code').lean();
  const programs = result.programs.map((p) => ({ ...p, department: guessDepartment(p.name, departments) }));
  const warnings = [...result.warnings];
  if (!programs.length) warnings.push('No programmes or subjects could be found. Check that the file is a curriculum with semester headings and course codes, or add the subjects manually below.');

  const imp = await CurriculumImport.create({
    uploadedBy: req.user._id,
    file: toFileDocs([file])[0],
    method: result.method,
    warnings,
    textLength: text.length,
    programs,
  });
  logAudit(req, 'curriculum.upload', 'CurriculumImport', imp._id, { method: imp.method, programs: programs.length, subjects: countSubjects(programs) });
  sendSuccess(res, imp, 'Curriculum read. Review it before saving', 201);
});

export const listImports = asyncHandler(async (_req, res) => {
  const list = await CurriculumImport.find({ status: { $ne: 'discarded' } }).sort({ createdAt: -1 }).limit(30);
  sendSuccess(res, list.map(summary));
});

export const getImport = asyncHandler(async (req, res) => sendSuccess(res, await loadImport(req.params.id)));

// The administrator corrects the draft: rename programmes, choose departments, fix or add subjects, remove wrong ones.
export const updateImport = asyncHandler(async (req, res) => {
  const imp = await loadImport(req.params.id);
  if (imp.status !== 'review') throw ApiError.conflict('This import is already finished');

  const deptIds = [...new Set(req.body.programs.map((p) => p.department).filter(Boolean))];
  if (deptIds.length) {
    const found = await Department.countDocuments({ _id: { $in: deptIds }, status: DEPARTMENT_STATUS.ACTIVE });
    if (found !== deptIds.length) throw ApiError.badRequest('A selected department was not found or is not active');
  }
  assertDraftConsistent(req.body.programs);

  imp.programs = req.body.programs.map((p) => ({
    name: p.name,
    department: p.department || null,
    semesters: [...p.semesters].sort((a, b) => a.number - b.number).map((s) => ({ number: s.number, subjects: s.subjects.map((x) => ({ ...x, code: x.code.toUpperCase() })) })),
  }));
  await imp.save();
  sendSuccess(res, imp, 'Draft saved');
});

// Saving for real: every programme must have a department. An existing programme of the same name is replaced.
export const approveImport = asyncHandler(async (req, res) => {
  const imp = await loadImport(req.params.id);
  if (imp.status !== 'review') throw ApiError.conflict('This import is already finished');
  if (!imp.programs.length) throw ApiError.badRequest('There is nothing to save. Add at least one programme');

  const plain = imp.toObject().programs;
  assertDraftConsistent(plain);
  for (const p of plain) {
    if (!p.department) throw ApiError.badRequest(`Choose a department for "${p.name}" before saving`);
    if (!p.semesters.some((s) => s.subjects.length)) throw ApiError.badRequest(`"${p.name}" has no subjects`);
  }
  const deptIds = [...new Set(plain.map((p) => String(p.department)))];
  if ((await Department.countDocuments({ _id: { $in: deptIds }, status: DEPARTMENT_STATUS.ACTIVE })) !== deptIds.length) {
    throw ApiError.badRequest('A selected department was not found or is not active');
  }

  let replaced = 0;
  const classReport = { removed: 0, created: 0, kept: [] };
  for (const p of plain) {
    const existing = await Program.findOne({ department: p.department, name: new RegExp(`^${escapeRx(p.name)}$`, 'i') });
    const semesters = p.semesters.filter((s) => s.subjects.length);
    if (existing) {
      existing.name = p.name;
      existing.semesters = semesters;
      existing.status = 'active';
      existing.sourceImport = imp._id;
      await existing.save();
      replaced += 1;
      // Replacing a curriculum must also bring the classes that were built from the old one in line:
      // classes whose subject is gone are removed (unless they have real records), new subjects get classes.
      const sync = await syncProgramClasses(existing, req.user._id);
      classReport.removed += sync.removed;
      classReport.created += sync.created;
      classReport.kept.push(...sync.kept);
    } else {
      await Program.create({ name: p.name, department: p.department, semesters, sourceImport: imp._id, createdBy: req.user._id });
    }
  }
  imp.status = 'approved';
  imp.approvedBy = req.user._id;
  imp.approvedAt = new Date();
  await imp.save();

  logAudit(req, 'curriculum.approve', 'CurriculumImport', imp._id, { programs: plain.length, replaced, subjects: countSubjects(plain), classes: { removed: classReport.removed, created: classReport.created, kept: classReport.kept.length } });
  sendSuccess(res, { programs: plain.length, replaced, subjects: countSubjects(plain), classes: classReport }, 'Curriculum saved to the database');
});

// Reads the stored file again with the current reader. Fixes drafts that were made by an older reader
// without uploading the file once more. Department choices made in the review are kept (matched by programme name).
export const rereadImport = asyncHandler(async (req, res) => {
  const imp = await loadImport(req.params.id);
  if (imp.status !== 'review') throw ApiError.conflict('This import is already finished');
  if (!imp.file?.storedName) throw ApiError.badRequest('The uploaded file is no longer stored. Upload it again');

  const text = (await extractText(storedPath('curriculum', imp.file.storedName), imp.file.mimeType)) || '';
  if (text.trim().length < 40) throw ApiError.badRequest('No readable text was found in the stored file');

  const result = await extractCurriculum(text);
  const departments = await Department.find({ status: DEPARTMENT_STATUS.ACTIVE }).select('name code').lean();
  const chosen = new Map(imp.toObject().programs.filter((p) => p.department).map((p) => [p.name.toLowerCase(), p.department]));
  imp.programs = result.programs.map((p) => ({ ...p, department: chosen.get(p.name.toLowerCase()) || guessDepartment(p.name, departments) }));
  imp.warnings = result.warnings;
  imp.method = result.method;
  imp.textLength = text.length;
  await imp.save();
  logAudit(req, 'curriculum.reread', 'CurriculumImport', imp._id, { method: imp.method, subjects: countSubjects(imp.programs) });
  sendSuccess(res, imp, 'The file was read again. Check the subjects below');
});

export const discardImport = asyncHandler(async (req, res) => {
  const imp = await loadImport(req.params.id);
  if (imp.status === 'approved') throw ApiError.conflict('An approved import cannot be discarded. Delete the programme instead');
  removeStored('curriculum', [imp.file]);
  imp.status = 'discarded';
  await imp.save();
  sendSuccess(res, null, 'Import discarded');
});

// ---------- The saved catalogue ----------
// Principal: every department (optionally filtered). HOD: own department only.
export const listPrograms = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.UNIVERSITY_HEAD) {
    if (req.query.department) filter.department = req.query.department;
  } else {
    filter.department = req.user.department;
  }
  const programs = await Program.find(filter).populate('department', 'name code').sort({ name: 1 }).lean();
  sendSuccess(res, programs.map((p) => ({ ...p, subjectCount: p.semesters.reduce((n, s) => n + s.subjects.length, 0) })));
});

// Looks at the classes made from a programme: which can be removed (no real records) and which must stay.
const inspectProgramClasses = async (program) => {
  const courses = await Course.find({ program: program._id }).select('code title section semester').populate('semester', 'name').lean();
  const removable = [];
  const kept = [];
  for (const c of courses) {
    const blockers = await findBlockers(courseBlockerChecks(c));
    if (blockers.length) kept.push({ ...c, because: blockers.map(([n, label]) => `${n} ${label}`).join(', ') });
    else removable.push(c);
  }
  const students = removable.length
    ? (await CourseEnrollment.distinct('student', { course: { $in: removable.map((c) => c._id) } })).length
    : 0;
  return { courses, removable, kept, students };
};

// What would deleting this programme do? The principal reads this in the confirmation window first.
export const previewProgramDelete = asyncHandler(async (req, res) => {
  const program = await Program.findById(req.params.id);
  if (!program) throw ApiError.notFound('Programme not found');
  const r = await inspectProgramClasses(program);
  sendSuccess(res, {
    name: program.name,
    classes: r.courses.length,
    removable: r.removable.length,
    students: r.students,
    kept: r.kept.map((k) => ({ code: k.code, semester: k.semester?.name, because: k.because })),
  });
});

// Deletes a programme. Students are never deleted.
//   mode=remove (default): classes made from it are deleted together with their timetable slots and student enrollments,
//                          EXCEPT classes with real records (attendance, marks, assignments ...). Those stay and are
//                          only unlinked from the programme, so no academic history is lost.
//   mode=keep            : every class stays as it is and is just unlinked from the programme.
export const deleteProgram = asyncHandler(async (req, res) => {
  const program = await Program.findById(req.params.id);
  if (!program) throw ApiError.notFound('Programme not found');
  const mode = req.query.mode === 'keep' ? 'keep' : 'remove';

  let removed = 0;
  let kept = [];
  if (mode === 'remove') {
    const r = await inspectProgramClasses(program);
    for (const c of r.removable) {
      await purgeCourse(c);
      removed += 1;
    }
    kept = r.kept;
  }
  // Whatever is still there is detached, so nothing points at a programme that no longer exists.
  const detached = await Course.updateMany({ program: program._id }, { program: null });
  await program.deleteOne();

  logAudit(req, 'program.delete', 'Program', program._id, { name: program.name, mode, classesRemoved: removed, classesKept: detached.modifiedCount });
  sendSuccess(res, { removed, kept: kept.map((k) => ({ code: k.code, semester: k.semester?.name, because: k.because })), unlinked: detached.modifiedCount }, 'Programme deleted');
});

export const setProgramStatus = asyncHandler(async (req, res) => {
  const program = await Program.findById(req.params.id);
  if (!program) throw ApiError.notFound('Programme not found');
  program.status = req.body.status;
  await program.save();
  logAudit(req, `program.${program.status}`, 'Program', program._id);
  sendSuccess(res, program, `Programme ${program.status}`);
});

// Repairs a SAVED programme whose subjects came from an older, less accurate reading of the file (for example the
// elective option lists were counted as subjects, which gave semesters 7 and 8 about 20 subjects each).
//   1. the original file is read again with the current reader;
//   2. the programme's semesters are replaced by that result;
//   3. the classes already created from this programme are brought in line (see syncProgramClasses): wrong classes that
//      have no records are deleted, missing ones are created without a teacher so the HOD can assign them.
// Subjects typed in by hand after the first approval are replaced too, so the screen asks for confirmation first.
export const resyncProgram = asyncHandler(async (req, res) => {
  const program = await Program.findById(req.params.id);
  if (!program) throw ApiError.notFound('Programme not found');

  const imp = program.sourceImport ? await CurriculumImport.findById(program.sourceImport) : null;
  const file = imp?.file?.storedName ? storedPath('curriculum', imp.file.storedName) : null;
  if (!file || !fs.existsSync(file)) {
    throw ApiError.badRequest('The original curriculum file of this programme is no longer stored. Upload the curriculum again under "Upload & review"');
  }

  const text = (await extractText(file, imp.file.mimeType)) || '';
  if (text.trim().length < 40) throw ApiError.badRequest('No readable text was found in the stored file');

  const result = await extractCurriculum(text);
  const wanted = result.programs.find((p) => p.name.toLowerCase() === program.name.toLowerCase()) || (result.programs.length === 1 ? result.programs[0] : null);
  if (!wanted) {
    throw ApiError.badRequest(`"${program.name}" was not found in the file. Upload the curriculum again under "Upload & review" and approve it to replace this programme`);
  }

  program.semesters = [...wanted.semesters].sort((a, b) => a.number - b.number);
  await program.save();
  const classes = await syncProgramClasses(program, req.user._id);

  logAudit(req, 'program.resync', 'Program', program._id, {
    subjects: countSubjects([wanted]),
    classesRemoved: classes.removed,
    classesCreated: classes.created,
    classesKept: classes.kept.length,
  });
  sendSuccess(
    res,
    {
      semesters: program.semesters.map((s) => ({ number: s.number, subjects: s.subjects.length })),
      classes,
      warnings: result.warnings,
    },
    'Programme corrected from the original file'
  );
});
