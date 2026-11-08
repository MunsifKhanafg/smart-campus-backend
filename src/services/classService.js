import Course from '../models/Course.js';
import Semester from '../models/Semester.js';
import StudentProfile from '../models/StudentProfile.js';
import { enrollInCourses } from './enrollmentService.js';
import { findBlockers } from '../utils/blockers.js';
import { courseBlockerChecks, purgeCourse } from './courseRemoval.js';
import { CLOSED_SEMESTER_STATES, STUDENT_STATUS } from '../config/constants.js';

// The subjects a programme has for one semester number ([] when there are none).
export const subjectsOf = (program, semesterNumber) => program?.semesters.find((s) => s.number === semesterNumber)?.subjects || [];

// Creates a class (Course) for every subject x section that does not exist yet, without a teacher, and enrols the
// students already placed in that semester and section. Existing classes are never touched.
export const createMissingClasses = async ({ semester, program, subjects, sections, userId }) => {
  const departmentId = semester.department?._id || semester.department;
  const existing = await Course.find({ semester: semester._id, code: { $in: subjects.map((s) => s.code) }, section: { $in: sections } })
    .select('code section')
    .lean();
  const have = new Set(existing.map((c) => `${c.code}:${c.section}`));

  const made = [];
  for (const section of sections) {
    for (const subject of subjects) {
      if (have.has(`${subject.code}:${section}`)) continue;
      try {
        made.push(
          await Course.create({
            outline: subject.outline || '', // course contents from the curriculum
            title: subject.title,
            code: subject.code,
            creditHours: subject.creditHours,
            department: departmentId,
            semester: semester._id,
            program: program._id,
            section,
            startDate: semester.startDate,
            endDate: semester.endDate,
            createdBy: userId,
          })
        );
      } catch (err) {
        if (err.code !== 11000) throw err; // somebody created the same class a moment ago: treat it as existing
      }
    }
  }

  let enrolled = 0;
  for (const course of made) {
    const profiles = await StudentProfile.find({ semester: semester._id, section: course.section, status: STUDENT_STATUS.ACTIVE }).select('user').lean();
    enrolled += (await enrollInCourses(profiles.map((p) => p.user), [course], userId)).enrolled;
  }
  return { made, enrolled };
};

// After a programme's subject lists were corrected, brings every semester that already has classes from this
// programme back in line with it:
//   1. a class whose subject is no longer in that semester is deleted, unless it already has real records
//      (attendance, marks ...). Those are kept and reported, so no history is ever lost;
//   2. classes that stay get the corrected title and course contents;
//   3. subjects that have no class yet get one (in every section already in use), without a teacher.
// Classes the HOD created by hand (they have no programme) are not touched.
export const syncProgramClasses = async (program, userId) => {
  const courses = await Course.find({ program: program._id }).lean();
  const bySemester = new Map();
  for (const c of courses) {
    const key = String(c.semester);
    if (!bySemester.has(key)) bySemester.set(key, []);
    bySemester.get(key).push(c);
  }

  const semesters = await Semester.find({ _id: { $in: [...bySemester.keys()] } });
  const report = { removed: 0, updated: 0, created: 0, notOffered: 0, kept: [], semesters: [] };

  for (const semester of semesters) {
    const list = bySemester.get(String(semester._id));
    const subjects = subjectsOf(program, semester.number);
    const codes = new Set(subjects.map((s) => s.code));

    for (const c of list.filter((x) => !codes.has(x.code))) {
      const blockers = await findBlockers(courseBlockerChecks(c));
      if (blockers.length) {
        report.kept.push({ semester: semester.name, code: c.code, title: c.title, because: blockers.map(([n, label]) => `${n} ${label}`).join(', ') });
        continue;
      }
      await purgeCourse(c);
      report.removed += 1;
    }

    for (const c of list.filter((x) => codes.has(x.code))) {
      const subject = subjects.find((s) => s.code === c.code);
      const patch = {};
      if (c.title !== subject.title) patch.title = subject.title;
      if (!c.outline && subject.outline) patch.outline = subject.outline;
      if (Object.keys(patch).length) {
        await Course.updateOne({ _id: c._id }, patch);
        report.updated += 1;
      }
    }

    // New subjects are NOT turned into classes here. The HOD decides which subjects of a semester are offered
    // (for example 5 of 21 in semester 7) on the Assign Teachers page; we only report how many are not offered.
    report.notOffered += subjects.filter((s) => !list.some((c) => c.code === s.code)).length;
    report.semesters.push({ name: semester.name, number: semester.number, subjects: subjects.length });
  }
  return report;
};
