import Course from '../models/Course.js';
import Attendance from '../models/Attendance.js';
import CourseTopic from '../models/CourseTopic.js';
import Assignment from '../models/Assignment.js';
import Quiz from '../models/Quiz.js';
import Submission from '../models/Submission.js';
import ExaminationMarks from '../models/ExaminationMarks.js';
import TimetableSlot from '../models/TimetableSlot.js';
import Notification from '../models/Notification.js';
import AIConversation from '../models/AIConversation.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import Semester from '../models/Semester.js'; // registered so the populate() below can read the semester name
import { notifyUsers } from '../utils/notify.js';
import { notifyTimetableChange } from './timetableService.js';
import { COURSE_STATUS, CLOSED_SEMESTER_STATES } from '../config/constants.js';

// What a teacher account is connected to. Shown in the confirmation window before the account is deleted.
export const teacherDataSummary = async (userId) => {
  const [courses, slots, attendance, topics, assignments, quizzes, graded, marks] = await Promise.all([
    Course.countDocuments({ teacher: userId }),
    TimetableSlot.countDocuments({ teacher: userId }),
    Attendance.countDocuments({ markedBy: userId }),
    CourseTopic.countDocuments({ createdBy: userId }),
    Assignment.countDocuments({ createdBy: userId }),
    Quiz.countDocuments({ createdBy: userId }),
    Submission.countDocuments({ gradedBy: userId }),
    ExaminationMarks.countDocuments({ enteredBy: userId }),
  ]);
  const items = [
    [courses, 'subjects they teach (they will have no teacher until you assign someone else)'],
    [slots, 'timetable classes (they stay on the timetable and show "No teacher assigned" until you choose a new teacher)'],
    [attendance, 'attendance sheets they marked (kept)'],
    [topics, 'teaching topics they created (kept)'],
    [assignments, 'assignments and presentations they created (kept)'],
    [quizzes, 'quizzes they created (kept)'],
    [graded, 'submissions they graded (kept)'],
    [marks, 'examination marks they entered (kept)'],
  ]
    .filter(([n]) => n > 0)
    .map(([count, label]) => ({ count, label }));
  return { items, hasRecords: items.length > 0 };
};

// Tells the HOD which subjects (and in which semester) are left without a teacher, and tells the students of those classes
// that their teacher will be announced. Students are only told when the timetable is published (they cannot see drafts).
const notifyNoTeacher = async ({ teacherName, departmentId, courses }) => {
  if (!courses.length) return;
  const dept = await Department.findById(departmentId).select('hod').lean();
  const lines = courses.map((c) => `${c.code} ${c.title} (${c.semester.name}, Section ${c.section})`);
  const shown = lines.slice(0, 12).join(' · ');
  const more = lines.length > 12 ? ` · and ${lines.length - 12} more` : '';
  const n = courses.length;
  if (dept?.hod) {
    await notifyUsers([dept.hod], {
      title: `${teacherName} was deleted: ${n} subject${n === 1 ? ' has' : 's have'} no teacher`.slice(0, 150),
      message: `No teacher assigned: ${shown}${more}. These classes stay on the timetable and show "No teacher assigned" until you choose a new teacher on the Assign Teachers page.`.slice(0, 900),
      type: 'course',
      link: '/assign-teachers',
    });
  }
  const slots = await TimetableSlot.find({ course: { $in: courses.map((c) => c._id) } }).select('timetable course').lean();
  const byTimetable = new Map();
  for (const s of slots) {
    if (!byTimetable.has(String(s.timetable))) byTimetable.set(String(s.timetable), new Set());
    byTimetable.get(String(s.timetable)).add(String(s.course));
  }
  const codeOf = new Map(courses.map((c) => [String(c._id), c.code]));
  for (const [timetableId, courseIds] of byTimetable) {
    await notifyTimetableChange({
      timetableId,
      courseIds: [...courseIds],
      message: `${[...courseIds].map((id) => codeOf.get(id)).join(', ')}: no teacher assigned for now. Your department will announce the new teacher.`,
    });
  }
};

// Deletes the teacher account.
//  - their subjects lose the teacher. Their classes STAY on the timetable and show "No teacher assigned" until the HOD gives
//    the subject to someone else (assigning a teacher moves the classes, see timetableService.reassignCourseSlots)
//  - the HOD is notified which subjects and semesters are left without a teacher
//  - everything they WROTE (attendance, topics, assignments, quizzes, grades, marks) is kept, because it belongs to the students'
//    academic record. It is handed over to the person who deleted the account, so every record still has a valid author.
// Returns the subjects of OPEN semesters that now have no teacher, for the confirmation message.
export const purgeTeacher = async (user, actingUserId) => {
  const id = user._id;
  // Read the subjects BEFORE the link is removed: afterwards nothing says who taught them.
  const taught = await Course.find({ teacher: id }).populate('semester', 'name number status').select('code title section semester status').lean();
  const open = taught.filter((c) => c.status === COURSE_STATUS.ACTIVE && c.semester && !CLOSED_SEMESTER_STATES.includes(c.semester.status));

  await Promise.all([
    Course.updateMany({ teacher: id }, { teacher: null }),
    TimetableSlot.updateMany({ teacher: id }, { teacher: null }),
    Attendance.updateMany({ markedBy: id }, { markedBy: actingUserId }),
    CourseTopic.updateMany({ createdBy: id }, { createdBy: actingUserId }),
    Assignment.updateMany({ createdBy: id }, { createdBy: actingUserId }),
    Quiz.updateMany({ createdBy: id }, { createdBy: actingUserId }),
    Submission.updateMany({ gradedBy: id }, { gradedBy: actingUserId }),
    ExaminationMarks.updateMany({ enteredBy: id }, { enteredBy: actingUserId }),
    Notification.deleteMany({ recipient: id }),
    AIConversation.deleteMany({ user: id }),
  ]);
  await User.deleteOne({ _id: id });
  await notifyNoTeacher({ teacherName: user.name, departmentId: user.department, courses: open });
  return { unassigned: open.map((c) => ({ code: c.code, title: c.title, section: c.section, semester: c.semester.name })) };
};
