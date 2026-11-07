import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import {
  createStudentSchema,
  updateStudentSchema,
  listStudentsQuery,
  studentStatusSchema,
  assignSemesterSchema,
  enrollSchema,
  myCoursesQuery,
  createSlotSchema,
  updateSlotSchema,
  createEventSchema,
  updateEventSchema,
  listEventsQuery,
  notificationsQuery,
} from '../validators/phase3Schemas.js';
import {
  createStudent,
  listStudents,
  myProfile,
  getStudent,
  updateStudent,
  setStudentStatus,
  assignSemester,
  deleteStudent,
} from '../controllers/studentController.js';
import { myRecord, studentRecord } from '../controllers/recordController.js';
import { courseStudents, enrollStudents, dropStudents, myCourses } from '../controllers/enrollmentController.js';
import {
  getSemesterTimetable,
  createSlot,
  updateSlot,
  deleteSlot,
  publishTimetable,
  unpublishTimetable,
  myTimetable,
} from '../controllers/timetableController.js';
import { listEvents, createEvent, updateEvent, deleteEvent } from '../controllers/calendarController.js';
import { listMyNotifications, markRead, markAllRead } from '../controllers/notificationController.js';

const { UNIVERSITY_HEAD, HOD, TEACHER, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const semesterParam = validate(z.object({ semesterId: objectId }), 'params');

// ---------- Students (mounted on /api/students) ----------
// Head and HOD create/list/view. Only the HOD edits, changes status and places students in semesters.
// NOTE: '/me' and '/me/record' must stay above '/:id'.
export const studentRouter = Router();
studentRouter.use(protect);
studentRouter.get('/me', authorize(STUDENT), myProfile);
studentRouter.get('/me/record', authorize(STUDENT), myRecord);
studentRouter.get('/', authorize(UNIVERSITY_HEAD, HOD), validate(listStudentsQuery, 'query'), listStudents);
studentRouter.post('/', authorize(UNIVERSITY_HEAD, HOD), validate(createStudentSchema), createStudent);
studentRouter.post('/assign-semester', authorize(HOD), validate(assignSemesterSchema), assignSemester);
studentRouter.get('/:id/record', authorize(UNIVERSITY_HEAD, HOD), idParam, studentRecord); // :id is the student's USER id
studentRouter.get('/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, getStudent); // :id is the StudentProfile id
studentRouter.put('/:id', authorize(HOD), idParam, validate(updateStudentSchema), updateStudent);
studentRouter.patch('/:id/status', authorize(HOD), idParam, validate(studentStatusSchema), setStudentStatus);
studentRouter.delete('/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, deleteStudent);

// ---------- Enrollment (mounted on /api/enrollments) ----------
export const enrollmentRouter = Router();
enrollmentRouter.use(protect);
enrollmentRouter.get('/my-courses', authorize(STUDENT), validate(myCoursesQuery, 'query'), myCourses);
enrollmentRouter.get('/course/:id', authorize(UNIVERSITY_HEAD, HOD, TEACHER), idParam, courseStudents);
enrollmentRouter.post('/course/:id/enroll', authorize(HOD), idParam, validate(enrollSchema), enrollStudents);
enrollmentRouter.post('/course/:id/drop', authorize(HOD), idParam, validate(enrollSchema), dropStudents);

// ---------- Timetables (mounted on /api/timetables) ----------
export const timetableRouter = Router();
timetableRouter.use(protect);
timetableRouter.get('/mine', authorize(STUDENT, TEACHER, HOD), myTimetable);
timetableRouter.get('/semester/:semesterId', authorize(UNIVERSITY_HEAD, HOD), semesterParam, getSemesterTimetable);
timetableRouter.post('/semester/:semesterId/publish', authorize(HOD), semesterParam, publishTimetable);
timetableRouter.post('/semester/:semesterId/unpublish', authorize(HOD), semesterParam, unpublishTimetable);
timetableRouter.post('/slots', authorize(HOD), validate(createSlotSchema), createSlot);
timetableRouter.put('/slots/:id', authorize(HOD), idParam, validate(updateSlotSchema), updateSlot);
timetableRouter.delete('/slots/:id', authorize(HOD), idParam, deleteSlot);

// ---------- Academic calendar (mounted on /api/calendar) ----------
export const calendarRouter = Router();
calendarRouter.use(protect);
calendarRouter.get('/', validate(listEventsQuery, 'query'), listEvents);
calendarRouter.post('/', authorize(UNIVERSITY_HEAD, HOD), validate(createEventSchema), createEvent);
calendarRouter.put('/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, validate(updateEventSchema), updateEvent);
calendarRouter.delete('/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, deleteEvent);

// ---------- Notifications (mounted on /api/notifications) ----------
export const notificationRouter = Router();
notificationRouter.use(protect);
notificationRouter.get('/', validate(notificationsQuery, 'query'), listMyNotifications);
notificationRouter.post('/read-all', markAllRead);
notificationRouter.patch('/:id/read', idParam, markRead);
