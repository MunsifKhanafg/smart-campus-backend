import Program from '../models/Program.js';
import { normalizeCode } from './curriculumService.js';

// ==========================================================================================================
// Course contents (the "outline") and the official subject name of a class come from the approved BS curriculum
// of its department. They are copied into the class automatically when
//   - the HOD assigns a teacher to the class (either screen), and
//   - a teacher or HOD opens a class whose contents are still empty (this fills classes created before the contents existed), and
//   - the HOD presses "Get contents from curriculum" (this can also bring in the official subject name).
// A class that already has contents is never overwritten automatically, so a teacher's or HOD's own text is safe.
//
// A class is matched to its curriculum subject by CODE first ("CS-101"), then by SUBJECT NAME ("Programming Fundamentals").
// The name match is what rescues classes the HOD typed by hand with a different code. The semester number breaks ties.
// ==========================================================================================================

const idOf = (v) => String(v?._id || v);

// "Intro. to Programming & Design" -> "intro to programming and design"
export const normalizeTitle = (t) =>
  String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// 3 = same name, 2 = one name contains the other (e.g. "Calculus" in "Calculus and Analytical Geometry"), 0 = no match
export const titleScore = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 3;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 8 && ` ${long} `.includes(` ${short} `) ? 2 : 0;
};

// Finds the curriculum subject of this class. Returns { title, creditHours, outline, program, programName, semesterNumber, how, score } or null.
export const curriculumSubjectFor = async ({ code, title, department, semesterNumber, program }) => {
  const wantedCode = normalizeCode(code);
  const wantedTitle = normalizeTitle(title);
  const programs = await Program.find({ department: idOf(department), status: 'active' }).lean();
  let best = null;
  for (const p of programs) {
    for (const s of p.semesters) {
      for (const sub of s.subjects) {
        const byCode = !!wantedCode && normalizeCode(sub.code) === wantedCode;
        const byTitle = titleScore(wantedTitle, normalizeTitle(sub.title));
        if (!byCode && !byTitle) continue;
        const score =
          (byCode ? 5 : byTitle) +
          (semesterNumber && s.number === semesterNumber ? 2 : 0) +
          (program && idOf(program) === String(p._id) ? 1 : 0) +
          (sub.outline ? 0.5 : 0); // among equal matches, prefer the one that has contents
        if (!best || score > best.score) {
          best = {
            title: sub.title,
            creditHours: sub.creditHours,
            outline: sub.outline || '',
            program: p._id,
            programName: p.name,
            semesterNumber: s.number,
            how: byCode ? 'code' : 'name',
            score,
          };
        }
      }
    }
  }
  return best;
};

// Fills the contents of ONE class document (not saved here). Returns true when something was filled.
export const fillOutline = async (course, semesterNumber) => {
  if (String(course.outline || '').trim()) return false;
  const found = await curriculumSubjectFor({
    code: course.code,
    title: course.title,
    department: course.department,
    semesterNumber: semesterNumber ?? course.semester?.number,
    program: course.program,
  });
  if (!found || !found.outline) return false;
  course.outline = found.outline;
  if (!course.program) course.program = found.program;
  return true;
};

// For a list of class documents: fills the empty ones and saves them.
export const backfillOutlines = async (courses) => {
  let filled = 0;
  for (const course of courses) {
    if (String(course.outline || '').trim()) continue;
    if (await fillOutline(course)) {
      await course.save();
      filled += 1;
    }
  }
  return filled;
};

// HOD action: bring the official subject name and the course contents of the curriculum into ONE class (not saved here).
// By default a class that already has its own contents keeps them; pass { overwrite: true } to replace them.
// Credit hours are never changed here, because they drive the timetable.
// Returns { matched, changed: ['name','contents'], source }.
export const syncFromCurriculum = async (course, { overwrite = false } = {}) => {
  const found = await curriculumSubjectFor({
    code: course.code,
    title: course.title,
    department: course.department,
    semesterNumber: course.semester?.number,
    program: course.program,
  });
  if (!found) return { matched: false, changed: [], source: null };

  const changed = [];
  if (found.title && found.title !== course.title) { course.title = found.title; changed.push('name'); }
  if (found.outline && (overwrite || !String(course.outline || '').trim()) && found.outline !== course.outline) { course.outline = found.outline; changed.push('contents'); }
  if (!course.program) course.program = found.program;
  return {
    matched: true,
    changed,
    hasContents: !!found.outline,
    source: `${found.programName}, semester ${found.semesterNumber} (${found.how === 'code' ? 'same code' : 'same subject name'})`,
  };
};
