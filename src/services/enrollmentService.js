import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import { COURSE_STATUS, ENROLLMENT_STATUS } from '../config/constants.js';

// Enrols students (User ids) in the given courses.
// Already-enrolled students are skipped; a previously dropped row is re-activated instead of duplicated.
export const enrollInCourses = async (studentIds, courses, enrolledBy) => {
  if (!studentIds.length || !courses.length) return { enrolled: 0, alreadyEnrolled: 0 };

  const existing = await CourseEnrollment.find({
    student: { $in: studentIds },
    course: { $in: courses.map((c) => c._id) },
    status: ENROLLMENT_STATUS.ENROLLED,
  })
    .select('student course')
    .lean();
  const have = new Set(existing.map((e) => `${e.student}:${e.course}`));

  const ops = [];
  for (const course of courses) {
    for (const student of studentIds) {
      if (have.has(`${student}:${course._id}`)) continue;
      ops.push({
        updateOne: {
          filter: { student, course: course._id },
          update: {
            $set: {
              semester: course.semester,
              department: course.department,
              status: ENROLLMENT_STATUS.ENROLLED,
              enrolledAt: new Date(),
              enrolledBy,
            },
            $unset: { droppedAt: '', droppedBy: '' },
          },
          upsert: true,
        },
      });
    }
  }
  if (ops.length) await CourseEnrollment.bulkWrite(ops);
  return { enrolled: ops.length, alreadyEnrolled: have.size };
};

// Enrols student profiles in every active course of a semester that matches the student's section.
export const autoEnrollSemester = async (profiles, semesterId, enrolledBy) => {
  const courses = await Course.find({ semester: semesterId, status: COURSE_STATUS.ACTIVE });
  let enrolled = 0;
  for (const course of courses) {
    const ids = profiles.filter((p) => p.section === course.section).map((p) => p.user);
    const result = await enrollInCourses(ids, [course], enrolledBy);
    enrolled += result.enrolled;
  }
  return { enrolled, courses: courses.length };
};
