// Which teachers fit which subject, and which departments a teacher serves. Pure functions (no database), unit tested.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Common subjects are taught in many departments (English, Mathematics, Islamiat ...). Each area lists words that identify the
// subject from its title. Note: "management" is NOT a word, because "Database Management Systems" is a computer science subject.
export const SUBJECT_AREAS = [
  { id: 'english', label: 'English', words: ['english', 'communication skills', 'technical and scientific writing', 'technical writing', 'report writing', 'composition', 'expository'] },
  { id: 'urdu', label: 'Urdu', words: ['urdu'] },
  { id: 'islamiat', label: 'Islamiat', words: ['islamiat', 'islamic', 'quran', 'seerah'] },
  { id: 'pakistan studies', label: 'Pakistan Studies', words: ['pakistan studies', 'pakistan', 'civics', 'citizenship'] },
  { id: 'statistics', label: 'Statistics', related: ['mathematics'], words: ['statistic', 'probability'] },
  { id: 'mathematics', label: 'Mathematics', words: ['math', 'calculus', 'algebra', 'geometry', 'differential', 'discrete', 'numerical', 'trigonometry', 'integral'] },
  { id: 'physics', label: 'Physics', words: ['physics'] },
  { id: 'chemistry', label: 'Chemistry', words: ['chemistry'] },
  { id: 'economics', label: 'Economics', words: ['economics'] },
  { id: 'business', label: 'Business', words: ['entrepreneurship', 'marketing', 'accounting', 'business'] },
];

// The common-subject area of a subject title, or null when it is an ordinary subject of one department.
export const subjectArea = (title) => {
  const t = norm(title);
  return SUBJECT_AREAS.find((a) => a.words.some((w) => t.includes(w))) || null;
};

// Does a teacher's list of subjects fit this subject? "Maths" fits Calculus, "English" fits Technical and Scientific Writing,
// "Data Structures" fits Data Structures and Algorithms.
export const teacherMatchesSubject = (tags, subject) => {
  const list = (tags || []).map(norm).filter((t) => t.length >= 3);
  if (!list.length) return false;
  const title = norm(subject.title);
  const area = subjectArea(subject.title);
  return list.some((t) => {
    if (title.includes(t) || (title.length >= 4 && t.includes(title))) return true;
    if (!area) return false;
    return t === area.id || t === norm(area.label) || (area.related || []).includes(t) || area.words.some((w) => t.includes(w));
  });
};

// For the assignment board: which of these teachers fit the subject, and which common-subject area it belongs to.
export const relevantTeachers = (subject, teachers) => ({
  area: subjectArea(subject.title)?.label || null,
  ids: teachers.filter((t) => teacherMatchesSubject(t.subjects, subject)).map((t) => String(t._id)),
});

// A teacher serves a department when it is their own, or when the administrator linked them to it (extraDepartments).
export const teacherServesDepartment = (teacher, departmentId) =>
  String(teacher.department) === String(departmentId) || (teacher.extraDepartments || []).some((d) => String(d?._id || d) === String(departmentId));

// Weekly teaching hours of a class. Normally the credit hours, but the administrator can set the real number of hours per week
// (a 3 credit-hour course that really meets 4 hours a week). There is no fixed upper limit.
export const weeklyHoursOf = (course) => course.weeklyHours || course.creditHours || 0;

// How loaded a teacher is, against the limit the administrator configured for THAT teacher.
// No limit set -> never "over". level: low < 60% <= mid < 100% <= high; over = above the limit.
export const loadStatus = (hours, limit) => {
  if (!limit) return { level: 'none', over: false, percent: null };
  const percent = Math.round((hours / limit) * 100);
  return { level: percent >= 100 ? 'high' : percent >= 60 ? 'mid' : 'low', over: hours > limit, percent };
};
