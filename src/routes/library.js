import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  bookSchema, bookUpdateSchema, booksQuery, addCopiesSchema, copyStatusSchema, labelsQuery, issueSchema, returnSchema, renewSchema, lostSchema, paymentSchema,
  lookupQuery, loansQuery, studentsQuery, reservationsQuery, messagesQuery, activityQuery, complaintsQuery, rulesSchema, reserveSchema, reportParams, reportQuery,
} from '../validators/librarySchemas.js';
import * as c from '../controllers/libraryController.js';

const { UNIVERSITY_HEAD, LIBRARY_CONTROLLER, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const studentParam = validate(z.object({ id: z.string().trim().min(1).max(40) }), 'params'); // an id or a roll number

// ============================================================================================================
// /api/library
//   Library controller (LIBRARY_CONTROLLER): runs the library (books, desk, reservations, fines, reports).
//   Principal (UNIVERSITY_HEAD): monitors everything read-only, and may change the library rules. The principal gives the library controller
//                                access by creating that account on the Users page.
//   Student: the catalogue and their OWN library (the id comes from the login token, never from the request).
// ============================================================================================================
export const libraryRouter = Router();
libraryRouter.use(protect);

// ----- the student's own library -----
libraryRouter.get('/me/summary', authorize(STUDENT), c.mySummary);
libraryRouter.get('/me/messages', authorize(STUDENT), c.myMessages);
libraryRouter.post('/me/reserve', authorize(STUDENT), validate(reserveSchema), c.myReserve);
libraryRouter.delete('/me/reservations/:id', authorize(STUDENT), idParam, c.myCancelReservation);
libraryRouter.post('/me/loans/:id/renew', authorize(STUDENT), idParam, c.myRenew);

// ----- the catalogue: everybody in the library, and students -----
libraryRouter.get('/books', authorize(STUDENT, LIBRARY_CONTROLLER, UNIVERSITY_HEAD), validate(booksQuery, 'query'), c.listBooks);
libraryRouter.get('/categories', authorize(STUDENT, LIBRARY_CONTROLLER, UNIVERSITY_HEAD), c.categories);

// ----- monitoring: the library controller and the principal (read-only for the principal) -----
const watch = authorize(LIBRARY_CONTROLLER, UNIVERSITY_HEAD);
libraryRouter.get('/dashboard', watch, c.dashboard);
libraryRouter.get('/books/:id', watch, idParam, c.getBook);
libraryRouter.get('/students', watch, validate(studentsQuery, 'query'), c.students);
libraryRouter.get('/students/:id', watch, studentParam, c.studentDetail);
libraryRouter.get('/loans', watch, validate(loansQuery, 'query'), c.listLoans);
libraryRouter.get('/reservations', watch, validate(reservationsQuery, 'query'), c.listReservations);
libraryRouter.get('/messages', watch, validate(messagesQuery, 'query'), c.listMessages);
libraryRouter.get('/activity', watch, validate(activityQuery, 'query'), c.listActivity);
libraryRouter.get('/complaints', watch, validate(complaintsQuery, 'query'), c.listLibraryComplaints);
libraryRouter.get('/rules', watch, c.getRules);
libraryRouter.put('/rules', watch, validate(rulesSchema), c.saveRules);
libraryRouter.get('/reports/:type', watch, validate(reportParams, 'params'), validate(reportQuery, 'query'), c.report);

// ----- only the library controller changes anything else -----
const run = authorize(LIBRARY_CONTROLLER);
libraryRouter.post('/books', run, validate(bookSchema), c.createBook);
libraryRouter.put('/books/:id', run, idParam, validate(bookUpdateSchema), c.updateBook);
libraryRouter.delete('/books/:id', run, idParam, c.removeBook);
libraryRouter.post('/books/:id/copies', run, idParam, validate(addCopiesSchema), c.addCopies);
libraryRouter.patch('/copies/:id/status', run, idParam, validate(copyStatusSchema), c.setCopyStatus);
libraryRouter.get('/labels', run, validate(labelsQuery, 'query'), c.labels);

libraryRouter.get('/lookup', run, validate(lookupQuery, 'query'), c.lookup);
libraryRouter.post('/issue', run, validate(issueSchema), c.issue);
libraryRouter.post('/return', run, validate(returnSchema), c.returnBook);
libraryRouter.post('/renew', run, validate(renewSchema), c.renew);
libraryRouter.post('/lost', run, validate(lostSchema), c.markLost);
libraryRouter.post('/payments', run, validate(paymentSchema), c.payment);
libraryRouter.delete('/reservations/:id', run, idParam, c.cancelReservation);
libraryRouter.post('/jobs/run', run, c.runJobsNow);
