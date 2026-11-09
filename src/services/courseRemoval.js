import Course from '../models/Course.js';
import Attendance from '../models/Attendance.js';
import CourseTopic from '../models/CourseTopic.js';
import Assignment from '../models/Assignment.js';
import Submission from '../models/Submission.js';
import Quiz from '../models/Quiz.js';
import QuizAttempt from '../models/QuizAttempt.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import Examination from '../models/Examination.js';
import Result from '../models/Result.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import TimetableSlot from '../models/TimetableSlot.js';
import AIConversation from '../models/AIConversation.js';
import Complaint from '../models/Complaint.js';
import MaterialChunk from '../models/MaterialChunk.js';
import { removeStoredAnywhere } from '../middleware/upload.js';

// What makes a class "real". As soon as any of this exists the class may not be deleted quietly (it can be archived).
// Returns checks in the [label, countPromise] shape used by utils/blockers.js. Used when the program is re-synced, where
// nothing may be deleted without the HOD's confirmation.
export const courseBlockerChecks = (course) => {
  const byCourse = { course: course._id };
  return [
    ['attendance records', Attendance.countDocuments(byCourse)],
    ['teaching topics', CourseTopic.countDocuments(byCourse)],
    ['assignments', Assignment.countDocuments(byCourse)],
    ['assignment submissions', Submission.countDocuments(byCourse)],
    ['quizzes', Quiz.countDocuments(byCourse)],
    ['quiz attempts', QuizAttempt.countDocuments(byCourse)],
    ['entered examination marks', ExaminationMarks.countDocuments(byCourse)],
    ['examination papers', Examination.countDocuments({ 'papers.course': course._id })],
    ['results', Result.countDocuments({ 'subjects.course': course._id })],
  ];
};

// Removes a class together with the things that exist only because of it:
// its timetable slots, student enrollments and AI chats. Complaints that mention it keep existing, just without the link.
export const purgeCourse = async (course) => {
  const byCourse = { course: course._id };
  await Promise.all([
    TimetableSlot.deleteMany(byCourse), // the subject also disappears from the timetable
    CourseEnrollment.deleteMany(byCourse),
    AIConversation.deleteMany(byCourse),
    Complaint.updateMany({ relatedCourse: course._id }, { relatedCourse: null }),
  ]);
  await Course.deleteOne({ _id: course._id });
};

// ---------- "Delete this subject and everything in it" (after the HOD confirmed) ----------

// What is inside a subject: shown in the confirmation window before anything is deleted.
// A subject that is part of saved RESULTS is never deleted this way: results are official records.
export const courseDataSummary = async (course) => {
  const byCourse = { course: course._id };
  const [attendance, topics, assignments, submissions, quizzes, attempts, marks, papers, results] = await Promise.all([
    Attendance.countDocuments(byCourse),
    CourseTopic.countDocuments(byCourse),
    Assignment.countDocuments(byCourse),
    Submission.countDocuments(byCourse),
    Quiz.countDocuments(byCourse),
    QuizAttempt.countDocuments(byCourse),
    ExaminationMarks.countDocuments(byCourse),
    Examination.countDocuments({ 'papers.course': course._id }),
    Result.countDocuments({ 'subjects.course': course._id }),
  ]);
  const items = [
    [attendance, 'attendance sheets'],
    [topics, 'teaching topics and uploaded materials'],
    [assignments, 'assignments and presentations'],
    [submissions, 'student submissions'],
    [quizzes, 'quizzes'],
    [attempts, 'quiz attempts'],
    [marks, 'entered examination marks'],
    [papers, 'examination date-sheet entries'],
  ]
    .filter(([n]) => n > 0)
    .map(([count, label]) => ({ count, label }));
  return {
    items,
    hasRecords: items.length > 0,
    blocked: results > 0
      ? `${course.code} is part of ${results} saved result(s). Results are official records and cannot be deleted together with a subject. Archive the subject instead.`
      : null,
  };
};

// Deletes the subject and all its teaching data, then its uploaded files from disk.
export const purgeCourseDeep = async (course) => {
  const byCourse = { course: course._id };
  const [topics, assignments, submissions] = await Promise.all([
    CourseTopic.find(byCourse).select('materials'),
    Assignment.find(byCourse).select('attachments'),
    Submission.find(byCourse).select('files'),
  ]);
  const files = [
    ...topics.flatMap((t) => t.materials || []),
    ...assignments.flatMap((a) => a.attachments || []),
    ...submissions.flatMap((s) => s.files || []),
  ];

  await Promise.all([
    Attendance.deleteMany(byCourse),
    CourseTopic.deleteMany(byCourse),
    Assignment.deleteMany(byCourse),
    Submission.deleteMany(byCourse),
    Quiz.deleteMany(byCourse),
    QuizAttempt.deleteMany(byCourse),
    ExaminationMarks.deleteMany(byCourse),
    MaterialChunk.deleteMany(byCourse),
    // The subject leaves the examination date sheets; the examinations themselves stay.
    Examination.updateMany({ 'papers.course': course._id }, { $pull: { papers: { course: course._id } } }),
  ]);
  await purgeCourse(course); // timetable slots, enrollments, AI chats and the course itself
  removeStoredAnywhere(files);
};
