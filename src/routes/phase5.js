import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { publicResultLimiter } from '../middleware/rateLimit.js';
import { ROLES } from '../config/constants.js';
import {
  listExamsQuery, createExamSchema, updateExamSchema, createPaperSchema, updatePaperSchema, paperParams,
  marksQuery, saveMarksSchema, unlockMarksSchema, publicResultSchema,
} from '../validators/phase5Schemas.js';
import {
  listExaminations, getExamination, createExamination, updateExamination, addPaper, updatePaper, removePaper,
  publishExamination, unpublishExamination, myDatesheet,
} from '../controllers/examinationController.js';
import { getMarks, saveMarks, unlockMarks } from '../controllers/marksController.js';
import {
  compileResults, listExamResults, publishResults, myResults, downloadDmc, publicCheckResult, publicVerifyDmc,
} from '../controllers/resultController.js';

const { UNIVERSITY_HEAD, HOD, TEACHER, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const courseParam = validate(z.object({ courseId: objectId }), 'params');

// ---------- Examination sessions and date sheets ----------
export const examinationRouter = Router();
examinationRouter.use(protect);
examinationRouter.get('/', authorize(UNIVERSITY_HEAD, HOD, TEACHER), validate(listExamsQuery, 'query'), listExaminations);
examinationRouter.get('/mine', authorize(STUDENT), myDatesheet);
examinationRouter.post('/', authorize(HOD), validate(createExamSchema), createExamination);
examinationRouter.get('/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, getExamination);
examinationRouter.put('/:id', authorize(HOD), idParam, validate(updateExamSchema), updateExamination);
examinationRouter.post('/:id/publish', authorize(HOD), idParam, publishExamination);
examinationRouter.post('/:id/unpublish', authorize(HOD), idParam, unpublishExamination);
examinationRouter.post('/:id/papers', authorize(HOD), idParam, validate(createPaperSchema), addPaper);
examinationRouter.put('/:id/papers/:paperId', authorize(HOD), validate(paperParams, 'params'), validate(updatePaperSchema), updatePaper);
examinationRouter.delete('/:id/papers/:paperId', authorize(HOD), validate(paperParams, 'params'), removePaper);

// ---------- Marks (teacher enters, HOD may unlock) ----------
export const marksRouter = Router();
marksRouter.use(protect);
marksRouter.post('/unlock', authorize(HOD), validate(unlockMarksSchema), unlockMarks);
marksRouter.get('/course/:courseId', authorize(UNIVERSITY_HEAD, HOD, TEACHER), courseParam, validate(marksQuery, 'query'), getMarks);
marksRouter.put('/course/:courseId', authorize(TEACHER), courseParam, validate(saveMarksSchema), saveMarks);

// ---------- Results and DMC ----------
export const resultRouter = Router();
resultRouter.use(protect);
resultRouter.get('/mine', authorize(STUDENT), myResults);
resultRouter.get('/examination/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, listExamResults);
resultRouter.post('/examination/:id/compile', authorize(HOD), idParam, compileResults);
resultRouter.post('/examination/:id/publish', authorize(HOD), idParam, publishResults);
resultRouter.get('/:id/dmc', authorize(STUDENT, HOD, UNIVERSITY_HEAD), idParam, downloadDmc);

// ---------- Public, no login. Strictly rate limited ----------
export const publicResultRouter = Router();
publicResultRouter.post('/results', publicResultLimiter, validate(publicResultSchema), publicCheckResult);
publicResultRouter.post(
  '/dmc/verify',
  publicResultLimiter,
  validate(z.object({ dmcNumber: z.string().min(5).max(30), verificationCode: z.string().min(4).max(20) })),
  publicVerifyDmc
);
