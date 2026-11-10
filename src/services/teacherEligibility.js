// Which teachers can teach which subject, and how busy a teacher is.
// Pure functions (no database), so the rules can be tested on their own.
//
// A teacher lists the SUBJECTS they teach (for example "English", "Mathematics", "Islamiat", "Pakistan Studies", "Data Structures").
// When the HOD gives a subject a teacher, the list shows only the teachers whose subjects fit it. A teacher can also be allowed to
// teach in other departments (common subjects are taught everywhere), without a second account.

export const norm = (s) =>
  String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Subjects that every department has. A teacher who lists any word of a family can teach every course of that family.
const FAMILIES = {
  english: ['english', 'communication skills', 'technical writing', 'report writing', 'composition', 'grammar', 'comprehension', 'functional english', 'technical and scientific writing'],
  mathematics: ['mathematics', 'math', 'maths', 'calculus', 'algebra', 'linear algebra', 'geometry', 'analytical geometry', 'differential equations', 'discrete mathematics', 'discrete structures', 'numerical', 'probability', 'statistics', 'matlab'],
  islamiat: ['islamiat', 'islamic studies', 'islamic', 'quran', 'seerat', 'ethics'],
  pakistan_studies: ['pakistan studies', 'pak studies', 'pakistan', 'civics', 'history of pakistan', 'ideology'],
  physics: ['physics', 'applied physics', 'mechanics', 'electromagnetism'],
  chemistry: ['chemistry'],
  urdu: ['urdu'],
};

const familiesOf = (text) => {
  const t = ` ${norm(text)} `;
  return Object.entries(FAMILIES).filter(([, words]) => words.some((w) => t.includes(` ${norm(w)} `))).map(([k]) => k);
};

const STOP = new Set(['and', 'of', 'the', 'to', 'in', 'for', 'with', 'introduction', 'fundamentals', 'basic', 'basics', 'principles', 'advanced', 'applied', 'applications', 'application', 'studies', 'skills', 'theory', 'lab', 'practical', 'course', 'systems', 'technologies']);
const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t));

// A short code prefix such as "MATH" or "CS" written by the teacher.
const isCodePrefix = (tag) => /^[A-Za-z]{2,6}$/.test(String(tag).trim()) && String(tag).trim() === String(tag).trim().toUpperCase();
const codeNorm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Does one tag the teacher typed fit this subject?
export const tagFits = (tag, subject) => {
  const t = norm(tag);
  if (!t) return false;
  const title = norm(subject.title);
  const code = codeNorm(subject.code);

  // 1) same course code, or the tag is a code prefix ("MATH" fits MATH-432)
  if (code && codeNorm(tag) === code) return true;
  if (isCodePrefix(tag) && code.startsWith(codeNorm(tag)) && /\d/.test(code.slice(codeNorm(tag).length, codeNorm(tag).length + 1))) return true;

  // 2) the tag is a whole word or phrase of the title ("English" in "Functional English")
  if (title && ` ${title} `.includes(` ${t} `)) return true;

  // 3) a common-subject family (Mathematics fits Calculus and Linear Algebra)
  const subjectFamilies = familiesOf(subject.title);
  if (subjectFamilies.length && familiesOf(tag).some((f) => subjectFamilies.includes(f))) return true;

  // 4) every meaningful word of the tag is in the title, or the other way round (a more specific tag)
  const a = tokens(tag);
  const b = tokens(subject.title);
  if (a.length && a.every((x) => b.includes(x))) return true;
  if (b.length && b.length >= 2 && b.every((x) => a.includes(x))) return true;
  return false;
};

// taught = titles/codes of classes this teacher already has or had ([{ title, code }]). A teacher who already teaches the same
// subject fits it even when they never typed it in their list.
export const fitsSubject = (teacher, subject, taught = []) => {
  const tags = Array.isArray(teacher.subjects) ? teacher.subjects : [];
  if (tags.some((tag) => tagFits(tag, subject))) return { fit: true, why: 'subject' };
  const title = norm(subject.title);
  const code = codeNorm(subject.code);
  if (taught.some((c) => (code && codeNorm(c.code) === code) || (title && norm(c.title) === title))) return { fit: true, why: 'history' };
  return { fit: false, why: null };
};

// A teacher may be given classes in their own department and in the departments they are allowed to teach in.
export const canTeachIn = (teacher, departmentId) => {
  if (!teacher || !departmentId) return false;
  const id = String(departmentId._id || departmentId);
  if (String(teacher.department?._id || teacher.department) === id) return true;
  return (teacher.extraDepartments || []).some((d) => String(d._id || d) === id);
};

// ---------- workload ----------
// A class is taught as many times per week as the HOD set ("weeklyClasses"); when it is not set, it follows the credit hours.
export const weeklyClassesOf = (course) => Number(course.weeklyClasses) > 0 ? Number(course.weeklyClasses) : Number(course.creditHours) || 0;

// courses: the teacher's active classes. maxWeeklyHours: the limit the administrator set for this teacher (null = no limit).
// Returns plain numbers, and a level only when a limit exists (there is no built-in limit any more).
export const describeLoad = (courses = [], maxWeeklyHours = null) => {
  const weeklyClasses = courses.reduce((n, c) => n + weeklyClassesOf(c), 0);
  const creditHours = courses.reduce((n, c) => n + (Number(c.creditHours) || 0), 0);
  const max = Number(maxWeeklyHours) > 0 ? Number(maxWeeklyHours) : null;
  let level = 'none';
  if (max) {
    const r = weeklyClasses / max;
    level = r > 1 ? 'over' : r >= 0.8 ? 'high' : r >= 0.5 ? 'mid' : 'low';
  }
  return { classes: courses.length, weeklyClasses, creditHours, max, level };
};
