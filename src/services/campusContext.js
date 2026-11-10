import StudentProfile from '../models/StudentProfile.js';
import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import TimetableSlot from '../models/TimetableSlot.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import { ROLES, ENROLLMENT_STATUS, COURSE_STATUS, TIMETABLE_STATUS, DAYS } from '../config/constants.js';

// ==========================================================================================================
// "My courses & teachers": the facts of THIS project (subjects, teachers, credit hours, timetable, course contents) that the
// assistant may talk about. It is built on the server from the database, only for the person who asks:
//   student -> their own enrolled subjects and the teachers of those subjects
//   teacher -> the subjects they teach (with class sizes and their weekly classes)
//   HOD     -> the subjects and teachers of their own department
//   head    -> a short overview of the departments
// ==========================================================================================================

// Splits course contents into items (one per line, ";" or sentence; or per comma when it is one long list).
export const splitItems = (text, max = 40) => {
  const clean = (s) => s.replace(/^[\s\-•*\u2022\d.)]+/, '').replace(/\s+/g, ' ').trim().replace(/[.;,]$/, '');
  let items = String(text || '').split(/\r?\n|;|(?<=\.)\s+(?=[A-Z])/).map(clean).filter((s) => s.length > 2);
  if (items.length === 1 && items[0].includes(',')) items = items[0].split(',').map(clean).filter((s) => s.length > 2);
  return items.slice(0, max);
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const teacherLine = (t) => (t ? `${t.name}${t.qualification ? `, ${t.qualification}` : ''}${t.email ? `, ${t.email}` : ''}` : 'not assigned yet');

const slotsByCourse = async (courseIds) => {
  const slots = await TimetableSlot.find({ course: { $in: courseIds } }).populate('timetable', 'status').lean();
  const map = new Map();
  for (const s of slots.filter((x) => x.timetable?.status === TIMETABLE_STATUS.PUBLISHED)) {
    const key = String(s.course);
    map.set(key, [...(map.get(key) || []), s]);
  }
  for (const [k, list] of map) {
    list.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.startMinutes - b.startMinutes);
    map.set(k, list.map((s) => `${cap(s.day)} ${s.startTime}-${s.endTime} room ${s.room}`));
  }
  return map;
};

const courseRow = (c, slots, extra = {}) => ({
  code: c.code,
  title: c.title,
  section: c.section,
  semester: c.semester?.name || '',
  creditHours: c.creditHours,
  teacher: c.teacher || null,
  slots: slots.get(String(c._id)) || [],
  contents: splitItems(c.outline, extra.contentsMax ?? 40),
  students: extra.students?.get(String(c._id)),
});

// Returns { user, profile, courses, teachers, departments } (plain data, easy to test and to turn into text).
export const loadCampusData = async (user) => {
  const data = { user: { name: user.name, role: user.role }, profile: null, courses: [], teachers: [], departments: [] };

  if (user.role === ROLES.STUDENT) {
    const profile = await StudentProfile.findOne({ user: user._id }).populate('semester', 'name number').populate('department', 'name code').lean();
    if (profile) data.profile = { rollNumber: profile.rollNumber, department: profile.department?.name, semester: profile.semester?.name, section: profile.section };
    const ids = await CourseEnrollment.find({ student: user._id, status: ENROLLMENT_STATUS.ENROLLED, ...(profile?.semester ? { semester: profile.semester._id } : {}) }).distinct('course');
    const courses = await Course.find({ _id: { $in: ids }, status: COURSE_STATUS.ACTIVE }).populate('teacher', 'name email qualification').populate('semester', 'name').sort({ code: 1 }).lean();
    const slots = await slotsByCourse(courses.map((c) => c._id));
    data.courses = courses.map((c) => courseRow(c, slots));
  } else if (user.role === ROLES.TEACHER) {
    const courses = await Course.find({ teacher: user._id, status: COURSE_STATUS.ACTIVE }).populate('semester', 'name').sort({ code: 1 }).lean();
    const ids = courses.map((c) => c._id);
    const [slots, counts] = await Promise.all([
      slotsByCourse(ids),
      CourseEnrollment.aggregate([{ $match: { course: { $in: ids }, status: ENROLLMENT_STATUS.ENROLLED } }, { $group: { _id: '$course', n: { $sum: 1 } } }]),
    ]);
    const students = new Map(counts.map((c) => [String(c._id), c.n]));
    data.courses = courses.map((c) => courseRow(c, slots, { students }));
  } else if (user.role === ROLES.HOD) {
    const courses = await Course.find({ department: user.department, status: COURSE_STATUS.ACTIVE }).populate('teacher', 'name email qualification').populate('semester', 'name').sort({ code: 1 }).limit(80).lean();
    const slots = await slotsByCourse(courses.map((c) => c._id));
    data.courses = courses.map((c) => courseRow(c, slots, { contentsMax: 6 }));
    data.teachers = (await User.find({ department: user.department, role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true }).select('name email qualification').sort({ name: 1 }).lean())
      .map((t) => ({ ...t, courses: courses.filter((c) => String(c.teacher?._id) === String(t._id)).map((c) => `${c.code} (${c.semester?.name})`) }));
  } else if (user.role === ROLES.UNIVERSITY_HEAD) {
    const depts = await Department.find({ status: 'active' }).populate('hod', 'name').select('name code hod').sort({ name: 1 }).lean();
    const [teachers, students] = await Promise.all([
      User.aggregate([{ $match: { role: ROLES.TEACHER, isActive: true } }, { $group: { _id: '$department', n: { $sum: 1 } } }]),
      StudentProfile.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$department', n: { $sum: 1 } } }]),
    ]);
    const t = new Map(teachers.map((x) => [String(x._id), x.n]));
    const s = new Map(students.map((x) => [String(x._id), x.n]));
    data.departments = depts.map((d) => ({ name: d.name, code: d.code, hod: d.hod?.name || 'none', teachers: t.get(String(d._id)) || 0, students: s.get(String(d._id)) || 0 }));
  }
  return data;
};

// The facts as text for the model (inside <campus_data>).
export const campusText = (d) => {
  const lines = [`User: ${d.user.name} (${d.user.role})`];
  if (d.profile) lines.push(`Roll number ${d.profile.rollNumber}, ${d.profile.department}, ${d.profile.semester}, section ${d.profile.section}`);
  for (const c of d.courses) {
    lines.push(`\nSubject ${c.code} - ${c.title} | section ${c.section} | ${c.semester} | ${c.creditHours} credit hours | teacher: ${teacherLine(c.teacher)}${c.students != null ? ` | ${c.students} students` : ''}`);
    if (c.slots.length) lines.push(`  Weekly classes (${c.slots.length}): ${c.slots.join('; ')}`);
    else lines.push('  Weekly classes: not on a published timetable yet');
    if (c.contents.length) lines.push(`  Course contents:\n${c.contents.map((t, i) => `    ${i + 1}. ${t}`).join('\n')}`);
  }
  if (d.teachers.length) lines.push(`\nTeachers of the department:\n${d.teachers.map((t) => `  ${t.name}${t.qualification ? `, ${t.qualification}` : ''}, ${t.email}: ${t.courses.join(', ') || 'no subject yet'}`).join('\n')}`);
  if (d.departments.length) lines.push(`\nDepartments:\n${d.departments.map((x) => `  ${x.name} (${x.code}): HOD ${x.hod}, ${x.teachers} teachers, ${x.students} students`).join('\n')}`);
  return lines.join('\n').slice(0, 9000);
};

// When no AI key is configured the assistant still answers these project questions straight from the data.
export const campusFallback = (d, question) => {
  const q = String(question || '').toLowerCase();
  if (!d.courses.length && !d.departments.length) return 'I could not find any subjects linked to your account yet. Ask your HOD or the university office.';
  const wantsTeacher = /teacher|sir|madam|miss|instructor|professor|who teach|taught/.test(q);
  const wantsTime = /timetable|schedule|time|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|when|room|week/.test(q);
  const wantsContents = /content|syllabus|outline|topic|cover|chapter|unit/.test(q);
  const wantsCredit = /credit|hours/.test(q);
  const out = [];

  if (d.departments.length) {
    out.push('**Departments**', ...d.departments.map((x) => `- **${x.name}** (${x.code}): HOD ${x.hod}, ${x.teachers} teachers, ${x.students} students`));
    return out.join('\n');
  }
  for (const c of d.courses) {
    out.push(`### ${c.code} - ${c.title}`);
    const all = !wantsTeacher && !wantsTime && !wantsContents && !wantsCredit;
    if (all || wantsTeacher) out.push(`- **Teacher:** ${teacherLine(c.teacher)}`);
    if (all || wantsCredit) out.push(`- **Credit hours:** ${c.creditHours} · ${c.semester} · section ${c.section}`);
    if (all || wantsTime) out.push(`- **Weekly classes:** ${c.slots.length ? c.slots.join('; ') : 'not on a published timetable yet'}`);
    if (wantsContents) out.push(c.contents.length ? `- **Course contents:**\n${c.contents.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}` : '- **Course contents:** not added yet');
    out.push('');
  }
  out.push('_The AI model is not switched on, so this is a direct answer from your records. Add an AI key on the server for full conversations._');
  return out.join('\n');
};
