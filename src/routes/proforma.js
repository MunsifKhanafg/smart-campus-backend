import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  getSheet, getSuggestions, saveRows, exportCourse, submitProforma, unlockProforma, listSubmissions, getSubmission, exportSubmission, receiveSubmission,
} from '../controllers/proformaController.js';

const { UNIVERSITY_HEAD, HOD, TEACHER } = ROLES;
const courseParam = validate(z.object({ courseId: objectId }), 'params');
const courseFormat = validate(z.object({ courseId: objectId, format: z.enum(['pdf', 'xlsx']) }), 'params');
const subParam = validate(z.object({ id: objectId }), 'params');
const subFormat = validate(z.object({ id: objectId, format: z.enum(['pdf', 'xlsx']) }), 'params');

// null = "not entered". The limits of every part (5, 5, 5, 5, 20, 60) are checked again in the controller from the one list in proformaService.
const mark = z.number().min(0).max(60).nullable().optional();
const saveSchema = z.object({
  rows: z.array(z.object({ student: objectId, assignment: mark, quiz: mark, attendance: mark, presentation: mark, midterm: mark, finalTerm: mark })).min(1).max(500),
});
const submitSchema = z.object({
  recipients: z.array(z.enum(['principal', 'examination'])).min(1, 'Choose at least one recipient').max(2),
  note: z.string().trim().max(1000).optional(),
});
const listQuery = z.object({ department: objectId.optional(), semester: objectId.optional() });

// ============================================================================================================
// /api/proforma   Subject-wise marks proforma: 40 internal marks (assignment 5, quiz 5, attendance 5, presentation 5, midterm 20)
//                 + 60 final term = 100. Only plain code calculates totals and grades. AI is never used here.
// ============================================================================================================
export const proformaRouter = Router();
proformaRouter.use(protect);

// what was sent to the office (snapshots)
proformaRouter.get('/submissions', authorize(UNIVERSITY_HEAD, HOD, TEACHER), validate(listQuery, 'query'), listSubmissions);
proformaRouter.get('/submissions/:id', authorize(UNIVERSITY_HEAD, HOD, TEACHER), subParam, getSubmission);
proformaRouter.get('/submissions/:id/export/:format', authorize(UNIVERSITY_HEAD, HOD, TEACHER), subFormat, exportSubmission);
proformaRouter.post('/submissions/:id/receive', authorize(UNIVERSITY_HEAD, HOD), subParam, receiveSubmission);

// one subject
proformaRouter.get('/course/:courseId', authorize(UNIVERSITY_HEAD, HOD, TEACHER), courseParam, getSheet);
proformaRouter.get('/course/:courseId/suggest', authorize(TEACHER), courseParam, getSuggestions);
proformaRouter.put('/course/:courseId', authorize(TEACHER), courseParam, validate(saveSchema), saveRows);
proformaRouter.get('/course/:courseId/export/:format', authorize(UNIVERSITY_HEAD, HOD, TEACHER), courseFormat, exportCourse);
proformaRouter.post('/course/:courseId/submit', authorize(TEACHER), courseParam, validate(submitSchema), submitProforma);
proformaRouter.post('/course/:courseId/unlock', authorize(HOD), courseParam, unlockProforma);
