import Examination from '../models/Examination.js';
import Course from '../models/Course.js';
import { ApiError } from '../utils/apiHelpers.js';

// Two time ranges overlap when each one starts before the other ends. Back-to-back papers are fine.
export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

// The caller may pass populated documents or plain ids. This turns either into a comparable string.
const idOf = (v) => String(v?._id || v);

// Checks a paper against every other paper on the same day (all departments, because rooms are shared):
//   same room            -> conflict
//   same teacher         -> conflict
//   same semester        -> conflict (the students would have two papers at once)
export const assertNoPaperConflicts = async ({ examination, courseId, date, startMinutes, endMinutes, room, excludePaperId }) => {
  const sameDay = await Examination.find({ 'papers.date': date }).lean();
  const myCourse = await Course.findById(courseId).select('teacher code').lean();

  const clashing = [];
  for (const exam of sameDay) {
    for (const p of exam.papers) {
      if (String(p.date) !== String(date)) continue;
      if (excludePaperId && String(p._id) === String(excludePaperId)) continue;
      if (overlaps(startMinutes, endMinutes, p.startMinutes, p.endMinutes)) clashing.push({ exam, paper: p });
    }
  }
  if (!clashing.length) return;

  const otherCourses = await Course.find({ _id: { $in: clashing.map((c) => c.paper.course) } }).select('teacher code').lean();
  const byId = new Map(otherCourses.map((c) => [String(c._id), c]));

  for (const { exam, paper } of clashing) {
    const other = byId.get(String(paper.course));
    const sameDept = idOf(exam.department) === idOf(examination.department);
    if (paper.room === room.trim().toUpperCase()) {
      throw ApiError.conflict(
        sameDept
          ? `Room ${paper.room} is already used by ${other?.code} at ${paper.startTime}-${paper.endTime}`
          : `Room ${paper.room} is booked by another department at that time`
      );
    }
    if (myCourse?.teacher && other?.teacher && String(other.teacher) === String(myCourse.teacher)) {
      throw ApiError.conflict(`The teacher of ${myCourse.code} already has a paper at ${paper.startTime}-${paper.endTime} that day`);
    }
    if (idOf(exam.semester) === idOf(examination.semester)) {
      throw ApiError.conflict(`Students of this semester already have ${other?.code || 'a paper'} at ${paper.startTime}-${paper.endTime} that day`);
    }
  }
};
