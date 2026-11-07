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

// What makes a class "real". As soon as any of this exists the class may not be deleted (it can be archived).
// Returns checks in the [label, countPromise] shape used by utils/blockers.js.
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
    TimetableSlot.deleteMany(byCourse),
    CourseEnrollment.deleteMany(byCourse),
    AIConversation.deleteMany(byCourse),
    Complaint.updateMany({ relatedCourse: course._id }, { relatedCourse: null }),
  ]);
  await Course.deleteOne({ _id: course._id });
};
