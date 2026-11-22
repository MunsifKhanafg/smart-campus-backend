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

const { LIBRARY_CONTROLLER, UNIVERSITY_HEAD, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const studentParam = validate(z.object({ id: z.string().trim().min(1).max(40) }), 'params'); // an id or a roll number

// ============================================================================================================
// /api/library
//   Library controller (LIBRARY_CONTROLLER): runs the whole library (books, the desk, fines, reservations, reports, rules).
//                                            The principal gives somebody this access by creating a "Library Controller" account (Users page).
//   Principal (UNIVERSITY_HEAD)            : full access too. The principal can see everything the library does and can also run it (issue, receive,
//                                            edit books, take payments, change the rules). Every action is written to the activity log with the principal's name.
//   Student                                : read-only. The catalogue (which books are available) and their OWN issued books, return dates,
//                                            overdue books and library notifications (the id comes from the login token, never from the request).
//                                            Students cannot borrow, reserve, renew or return books online: that happens at the Library Office.
// ============================================================================================================
export const libraryRouter = Router();
libraryRouter.use(protect);

// ----- the student's own library (read-only) -----
libraryRouter.get('/me/summary', authorize(STUDENT), c.mySummary);
libraryRouter.get('/me/messages', authorize(STUDENT), c.myMessages);

// ----- the catalogue: library controller, principal (monitoring) and students -----
libraryRouter.get('/books', authorize(STUDENT, LIBRARY_CONTROLLER, UNIVERSITY_HEAD), validate(booksQuery, 'query'), c.listBooks);
libraryRouter.get('/categories', authorize(STUDENT, LIBRARY_CONTROLLER, UNIVERSITY_HEAD), c.categories);

// ----- reading everything else: library controller and principal (monitoring) -----
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
libraryRouter.get('/reports/:type', watch, validate(reportParams, 'params'), validate(reportQuery, 'query'), c.report);

// ----- everything that changes something: the library controller and the principal -----
const run = authorize(LIBRARY_CONTROLLER, UNIVERSITY_HEAD);
libraryRouter.put('/rules', run, validate(rulesSchema), c.saveRules);
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
