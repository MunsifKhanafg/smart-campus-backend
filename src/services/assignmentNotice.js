import CourseEnrollment from '../models/CourseEnrollment.js';
import { notifyUsers } from '../utils/notify.js';
import { ENROLLMENT_STATUS } from '../config/constants.js';

const CONTENTS_PREVIEW = 400;

// What a teacher is told when the HOD gives them a subject: the subject name and code, credit hours, semester,
// section, how many students are enrolled and the course contents. The full details are on the course page the link opens.
// Used by both ways of assigning a teacher (the assignment board and the Courses page), so the message is always the same.
export const buildAssignmentMessage = ({ course, semesterName, students }) => {
  const contents = String(course.outline || '').replace(/\s+/g, ' ').trim();
  const preview = contents.length > CONTENTS_PREVIEW ? `${contents.slice(0, CONTENTS_PREVIEW)}…` : contents;
  return [
    `${course.title} (${course.code})`,
    `${course.creditHours} credit hours`,
    semesterName,
    `Section ${course.section}`,
    `${students} student${students === 1 ? '' : 's'} enrolled`,
  ].filter(Boolean).join(' · ') + (preview ? `. Course contents: ${preview}` : '. Course contents have not been added yet.');
};

// Tells the new teacher what they received and the previous teacher that they were removed. Does nothing if nothing changed.
export const notifyTeacherChange = async ({ course, semesterName, previous, next }) => {
  if (String(previous || '') === String(next || '')) return;
  if (next) {
    const students = await CourseEnrollment.countDocuments({ course: course._id, status: ENROLLMENT_STATUS.ENROLLED });
    await notifyUsers([next], {
      title: `You were assigned ${course.code} - ${course.title}`.slice(0, 150),
      message: buildAssignmentMessage({ course, semesterName, students }),
      type: 'course',
      link: `/courses/${course._id}`,
    });
  }
  if (previous) {
    await notifyUsers([previous], {
      title: `You were removed from ${course.code}`,
      message: [course.title, semesterName].filter(Boolean).join(' · '),
      type: 'course',
      link: '/courses',
    });
  }
};
