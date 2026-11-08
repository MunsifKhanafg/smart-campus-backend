import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { privateUpload } from '../middleware/upload.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  listTopicsQuery, createTopicSchema, updateTopicSchema,
  listAssignmentsQuery, createAssignmentSchema, updateAssignmentSchema, submitAssignmentSchema, gradeSchema,
  sheetQuery, saveAttendanceSchema, myAttendanceQuery, deptAttendanceQuery,
  listQuizzesQuery, createQuizSchema, updateQuizSchema, answersSchema,
} from '../validators/phase4Schemas.js';
import {
  listTopics, createTopic, updateTopic, deleteTopic, uploadMaterials, deleteMaterial, downloadMaterial,
} from '../controllers/topicController.js';
import {
  listAssignments, getAssignment, createAssignment, updateAssignment, deleteAssignment, addAttachments,
  downloadAttachment, submitAssignment, listSubmissions, gradeSubmission, downloadSubmissionFile,
} from '../controllers/assignmentController.js';
import { getSheet, saveAttendance, courseSummary, myAttendance, departmentSummary, courseSessions, myClasses } from '../controllers/attendanceController.js';
import {
  createQuiz, updateQuiz, deleteQuiz, startSurprise, closeQuiz, listQuizzes, getQuiz, quizResults,
  startAttempt, saveAnswers, submitAttempt, myQuizResults,
} from '../controllers/quizController.js';

const { UNIVERSITY_HEAD, HOD, TEACHER, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const courseParam = validate(z.object({ courseId: objectId }), 'params');
const attemptParam = validate(z.object({ attemptId: objectId }), 'params');
const fileParam = validate(z.object({ id: objectId, storedName: z.string().regex(/^[a-f0-9]{32}\.[a-z0-9]{3,4}$/) }), 'params');
const ALL_ACADEMIC = [UNIVERSITY_HEAD, HOD, TEACHER, STUDENT];
const STAFF = [UNIVERSITY_HEAD, HOD, TEACHER];

// ---------- Topics ----------
export const topicRouter = Router();
topicRouter.use(protect);
topicRouter.get('/', authorize(...ALL_ACADEMIC), validate(listTopicsQuery, 'query'), listTopics);
topicRouter.post('/', authorize(TEACHER), validate(createTopicSchema), createTopic);
topicRouter.put('/:id', authorize(TEACHER), idParam, validate(updateTopicSchema), updateTopic);
topicRouter.delete('/:id', authorize(TEACHER), idParam, deleteTopic);
topicRouter.post('/:id/materials', authorize(TEACHER), idParam, ...privateUpload('materials', { maxMB: 20, maxFiles: 5 }), uploadMaterials);
topicRouter.delete('/:id/materials/:storedName', authorize(TEACHER), fileParam, deleteMaterial);
topicRouter.get('/:id/materials/:storedName', authorize(...ALL_ACADEMIC), fileParam, downloadMaterial);

// ---------- Assignments and presentations ----------
export const assignmentRouter = Router();
assignmentRouter.use(protect);
assignmentRouter.get('/', authorize(...ALL_ACADEMIC), validate(listAssignmentsQuery, 'query'), listAssignments);
assignmentRouter.post('/', authorize(TEACHER), validate(createAssignmentSchema), createAssignment);
assignmentRouter.patch('/submissions/:id/grade', authorize(TEACHER), idParam, validate(gradeSchema), gradeSubmission);
assignmentRouter.get('/submissions/:id/files/:storedName', authorize(...ALL_ACADEMIC), fileParam, downloadSubmissionFile);
assignmentRouter.get('/:id', authorize(...ALL_ACADEMIC), idParam, getAssignment);
assignmentRouter.put('/:id', authorize(TEACHER), idParam, validate(updateAssignmentSchema), updateAssignment);
assignmentRouter.delete('/:id', authorize(TEACHER), idParam, deleteAssignment);
assignmentRouter.post('/:id/attachments', authorize(TEACHER), idParam, ...privateUpload('assignments', { maxMB: 15, maxFiles: 3 }), addAttachments);
assignmentRouter.get('/:id/attachments/:storedName', authorize(...ALL_ACADEMIC), fileParam, downloadAttachment);
assignmentRouter.post('/:id/submit', authorize(STUDENT), idParam, ...privateUpload('submissions', { maxMB: 15, maxFiles: 3 }), validate(submitAssignmentSchema), submitAssignment);
assignmentRouter.get('/:id/submissions', authorize(...STAFF), idParam, listSubmissions);

// ---------- Attendance ----------
export const attendanceRouter = Router();
attendanceRouter.use(protect);
attendanceRouter.get('/me', authorize(STUDENT), validate(myAttendanceQuery, 'query'), myAttendance);
attendanceRouter.get('/department', authorize(UNIVERSITY_HEAD, HOD), validate(deptAttendanceQuery, 'query'), departmentSummary);
attendanceRouter.get('/mine', authorize(TEACHER), myClasses);
attendanceRouter.get('/course/:courseId/sessions', authorize(...STAFF), courseParam, courseSessions);
attendanceRouter.get('/course/:courseId/sheet', authorize(...STAFF), courseParam, validate(sheetQuery, 'query'), getSheet);
attendanceRouter.get('/course/:courseId/summary', authorize(...STAFF), courseParam, courseSummary);
attendanceRouter.put('/course/:courseId', authorize(TEACHER), courseParam, validate(saveAttendanceSchema), saveAttendance);

// ---------- Quizzes ----------
export const quizRouter = Router();
quizRouter.use(protect);
quizRouter.get('/', authorize(...ALL_ACADEMIC), validate(listQuizzesQuery, 'query'), listQuizzes);
quizRouter.get('/my-results', authorize(STUDENT), validate(listQuizzesQuery, 'query'), myQuizResults);
quizRouter.post('/', authorize(TEACHER), validate(createQuizSchema), createQuiz);
quizRouter.put('/attempts/:attemptId/answers', authorize(STUDENT), attemptParam, validate(answersSchema), saveAnswers);
quizRouter.post('/attempts/:attemptId/submit', authorize(STUDENT), attemptParam, validate(answersSchema), submitAttempt);
quizRouter.get('/:id', authorize(...STAFF), idParam, getQuiz);
quizRouter.put('/:id', authorize(TEACHER), idParam, validate(updateQuizSchema), updateQuiz);
quizRouter.delete('/:id', authorize(TEACHER), idParam, deleteQuiz);
quizRouter.post('/:id/start-surprise', authorize(TEACHER), idParam, startSurprise);
quizRouter.post('/:id/close', authorize(TEACHER), idParam, closeQuiz);
quizRouter.get('/:id/results', authorize(...STAFF), idParam, quizResults);
quizRouter.post('/:id/start', authorize(STUDENT), idParam, startAttempt);
