import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  createSemesterSchema,
  updateSemesterSchema,
  semesterStatusSchema,
  promoteSemesterSchema,
  listSemestersQuery,
  createCourseSchema,
  updateCourseSchema,
  assignTeacherSchema,
  courseStatusSchema,
  listCoursesQuery,
} from '../validators/academicSchemas.js';
import {
  listSemesters,
  getSemester,
  createSemester,
  updateSemester,
  setSemesterStatus,
  semesterSummary,
  deleteSemester,
  previewSemesterDelete,
  promoteSemester,
  semesterRoster,
} from '../controllers/semesterController.js';
import {
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  assignTeacher,
  setCourseStatus,
  deleteCourse,
  syncCurriculum,
  syncSemesterCurriculum,
} from '../controllers/courseController.js';
import { privateUpload } from '../middleware/upload.js';
import { programsQuery, draftSchema, boardQuery, assignSubjectSchema, generateCoursesSchema, offerSubjectsSchema, withdrawSubjectSchema, replaceSubjectSchema, matchSemesterSchema } from '../validators/curriculumSchemas.js';
import {
  createImport,
  listImports,
  getImport,
  updateImport,
  approveImport,
  rereadImport,
  discardImport,
  listPrograms,
  deleteProgram,
  previewProgramDelete,
  moveSubject,
  setProgramStatus,
  resyncProgram,
} from '../controllers/curriculumController.js';
import { board, assignSubject, generateCourses, offerSubjects, withdrawSubject, replaceSubject, matchSemester } from '../controllers/teachingController.js';

const { UNIVERSITY_HEAD, HOD, TEACHER, FINANCE_OFFICER } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');

// ---------- Semesters ----------
// Head: read-only across departments. HOD: full control of their own department. Teacher: read own department.
export const semesterRouter = Router();
semesterRouter.use(protect);
// The finance officer needs the semester list to write fee notices for any department.
semesterRouter.get('/', authorize(UNIVERSITY_HEAD, HOD, TEACHER, FINANCE_OFFICER), validate(listSemestersQuery, 'query'), listSemesters);
semesterRouter.post('/', authorize(HOD), validate(createSemesterSchema), createSemester);
semesterRouter.get('/:id', authorize(UNIVERSITY_HEAD, HOD, TEACHER), idParam, getSemester);
semesterRouter.get('/:id/summary', authorize(UNIVERSITY_HEAD, HOD), idParam, semesterSummary);
semesterRouter.get('/:id/roster', authorize(UNIVERSITY_HEAD, HOD), idParam, semesterRoster);
semesterRouter.get('/:id/delete-preview', authorize(HOD), idParam, previewSemesterDelete);
semesterRouter.put('/:id', authorize(HOD), idParam, validate(updateSemesterSchema), updateSemester);
semesterRouter.patch('/:id/status', authorize(HOD), idParam, validate(semesterStatusSchema), setSemesterStatus);
semesterRouter.post('/:id/promote', authorize(HOD), idParam, validate(promoteSemesterSchema), promoteSemester);
semesterRouter.delete('/:id', authorize(HOD), idParam, deleteSemester);

// ---------- Courses ----------
// A teacher only ever receives courses assigned to them (enforced inside the controller).
export const courseRouter = Router();
courseRouter.use(protect);
courseRouter.get('/', authorize(UNIVERSITY_HEAD, HOD, TEACHER), validate(listCoursesQuery, 'query'), listCourses);
courseRouter.post('/', authorize(HOD), validate(createCourseSchema), createCourse);
// Bring the official subject names and course contents of the BS curriculum into the classes (one class, or a whole semester).
courseRouter.post('/sync-curriculum', authorize(HOD), validate(z.object({ semester: objectId, overwrite: z.boolean().optional() })), syncSemesterCurriculum);
courseRouter.post('/:id/sync-curriculum', authorize(HOD), idParam, validate(z.object({ overwrite: z.boolean().optional() })), syncCurriculum);
courseRouter.get('/:id', authorize(UNIVERSITY_HEAD, HOD, TEACHER), idParam, getCourse);
courseRouter.put('/:id', authorize(HOD), idParam, validate(updateCourseSchema), updateCourse);
courseRouter.patch('/:id/teacher', authorize(HOD), idParam, validate(assignTeacherSchema), assignTeacher);
courseRouter.patch('/:id/status', authorize(HOD), idParam, validate(courseStatusSchema), setCourseStatus);
courseRouter.delete('/:id', authorize(HOD), idParam, deleteCourse);

// ---------- BS curriculum (AI-assisted import) ----------
// Only the principal uploads, edits and approves a curriculum. Nothing reaches the programme catalogue before approval.
// The HOD can read the approved programmes of their own department.
export const curriculumRouter = Router();
curriculumRouter.use(protect);
curriculumRouter.post('/imports', authorize(UNIVERSITY_HEAD), ...privateUpload('curriculum', { maxMB: 15, maxFiles: 1 }), createImport);
curriculumRouter.get('/imports', authorize(UNIVERSITY_HEAD), listImports);
curriculumRouter.get('/imports/:id', authorize(UNIVERSITY_HEAD), idParam, getImport);
curriculumRouter.put('/imports/:id', authorize(UNIVERSITY_HEAD), idParam, validate(draftSchema), updateImport);
curriculumRouter.post('/imports/:id/approve', authorize(UNIVERSITY_HEAD), idParam, approveImport);
curriculumRouter.post('/imports/:id/reread', authorize(UNIVERSITY_HEAD), idParam, rereadImport);
curriculumRouter.delete('/imports/:id', authorize(UNIVERSITY_HEAD), idParam, discardImport);
curriculumRouter.get('/programs', authorize(UNIVERSITY_HEAD, HOD), validate(programsQuery, 'query'), listPrograms);
curriculumRouter.patch('/programs/:id/status', authorize(UNIVERSITY_HEAD), idParam, validate(z.object({ status: z.enum(['active', 'archived']) })), setProgramStatus);
curriculumRouter.delete('/programs/:id', authorize(UNIVERSITY_HEAD), idParam, deleteProgram);
curriculumRouter.get('/programs/:id/delete-preview', authorize(UNIVERSITY_HEAD), idParam, previewProgramDelete);
curriculumRouter.post('/programs/:id/move-subject', authorize(UNIVERSITY_HEAD), idParam, validate(z.object({ code: z.string().trim().min(2).max(30), toSemester: z.number().int().min(1).max(12) })), moveSubject);
curriculumRouter.post('/programs/:id/resync', authorize(UNIVERSITY_HEAD), idParam, resyncProgram);

// ---------- HOD: teacher assignment board ----------
// The board is the HOD's workspace; the principal may open it read-only. Only the HOD can assign.
export const teachingRouter = Router();
teachingRouter.use(protect);
teachingRouter.get('/board', authorize(UNIVERSITY_HEAD, HOD), validate(boardQuery, 'query'), board);
teachingRouter.post('/generate', authorize(HOD), validate(generateCoursesSchema), generateCourses);
teachingRouter.post('/assign', authorize(HOD), validate(assignSubjectSchema), assignSubject);
// Offer only some subjects of a semester, stop offering one, or swap one for another (the old class leaves the timetable).
teachingRouter.post('/offer', authorize(HOD), validate(offerSubjectsSchema), offerSubjects);
teachingRouter.post('/withdraw', authorize(HOD), validate(withdrawSubjectSchema), withdrawSubject);
teachingRouter.post('/replace', authorize(HOD), validate(replaceSubjectSchema), replaceSubject);
// "Semester 5 must have exactly the subjects of the curriculum": fixes wrong, duplicate and missing classes (apply=false = preview).
teachingRouter.post('/match', authorize(HOD), validate(matchSemesterSchema), matchSemester);
