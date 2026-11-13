import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  bookSchema, bookUpdateSchema, booksQuery, addCopiesSchema, copyStatusSchema, labelsQuery, issueSchema, returnSchema, renewSchema, lostSchema, paymentSchema,
  lookupQuery, loansQuery, studentsQuery, reservationsQuery, messagesQuery, activityQuery, complaintsQuery, rulesSchema, deskReserveSchema, reportParams, reportQuery,
} from '../validators/librarySchemas.js';
import * as c from '../controllers/libraryController.js';

const { LIBRARY_CONTROLLER, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const studentParam = validate(z.object({ id: z.string().trim().min(1).max(40) }), 'params'); // an id or a roll number

// ============================================================================================================
// /api/library
//   Library controller (LIBRARY_CONTROLLER): runs the whole library (books, desk, reservations, fines, reports, rules).
//                                            This is the ONLY staff role with library access. The principal has no library screens.
//   Student: read-only. The catalogue (which books are available) and their OWN issued books, return dates, overdue books and
//            library notifications (the id comes from the login token, never from the request).
//            Students cannot borrow, reserve, renew or return books online: that happens at the Library Office.
// ============================================================================================================
export const libraryRouter = Router();
libraryRouter.use(protect);

// ----- the student's own library (read-only) -----
libraryRouter.get('/me/summary', authorize(STUDENT), c.mySummary);
libraryRouter.get('/me/messages', authorize(STUDENT), c.myMessages);

// ----- the catalogue: library controller and students -----
libraryRouter.get('/books', authorize(STUDENT, LIBRARY_CONTROLLER), validate(booksQuery, 'query'), c.listBooks);
libraryRouter.get('/categories', authorize(STUDENT, LIBRARY_CONTROLLER), c.categories);

// ----- everything else: the library controller only -----
const run = authorize(LIBRARY_CONTROLLER);
libraryRouter.get('/dashboard', run, c.dashboard);
libraryRouter.get('/books/:id', run, idParam, c.getBook);
libraryRouter.get('/students', run, validate(studentsQuery, 'query'), c.students);
libraryRouter.get('/students/:id', run, studentParam, c.studentDetail);
libraryRouter.get('/loans', run, validate(loansQuery, 'query'), c.listLoans);
libraryRouter.get('/reservations', run, validate(reservationsQuery, 'query'), c.listReservations);
libraryRouter.get('/messages', run, validate(messagesQuery, 'query'), c.listMessages);
libraryRouter.get('/activity', run, validate(activityQuery, 'query'), c.listActivity);
libraryRouter.get('/complaints', run, validate(complaintsQuery, 'query'), c.listLibraryComplaints);
libraryRouter.get('/rules', run, c.getRules);
libraryRouter.put('/rules', run, validate(rulesSchema), c.saveRules);
libraryRouter.get('/reports/:type', run, validate(reportParams, 'params'), validate(reportQuery, 'query'), c.report);

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
libraryRouter.post('/reservations', run, validate(deskReserveSchema), c.deskReserve); // recorded by the controller for a student who asks at the desk
libraryRouter.delete('/reservations/:id', run, idParam, c.cancelReservation);
libraryRouter.post('/jobs/run', run, c.runJobsNow);
