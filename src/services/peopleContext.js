import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import Department from '../models/Department.js';
import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import TimetableSlot from '../models/TimetableSlot.js';
import { ROLES, STUDENT_STATUS, COURSE_STATUS, ENROLLMENT_STATUS } from '../config/constants.js';

// ==========================================================================================================
// "Students & teachers": names and details of the people of the university, for the PRINCIPAL (everybody) and an HOD (only
// their own department). The page asks a question; this file finds the matching people in the database and the assistant
// (or, without an AI key, a direct answer) presents them. Nobody else can use it: students and teachers never get this data.
// ==========================================================================================================

const STOP = new Set(
  `a an and are all about as at be by can do does for from get give has have how i in info information is it list me my name names of on or please
  show tell that the their them there these this those to us what when where which who whom with you your full detail details data every each total count many much
  student students teacher teachers faculty staff lecturer lecturers professor professors hod hods head heads department departments semester semesters class classes
  section sections roll number numbers phone email emails contact subject subjects course courses sir madam miss mr mrs dr`.split(/\s+/)
);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Understands the question: which kind of people, which department / semester, which names or roll numbers.
export const parseQuestion = (question, departments = []) => {
  const text = String(question || '').toLowerCase();
  const sem = text.match(/semester\s*(?:no\.?|number)?\s*(\d{1,2})|(\d{1,2})\s*(?:st|nd|rd|th)?\s*semester/);
  const words = [...new Set(text.match(/[a-z0-9][a-z0-9'.-]{1,}/g) || [])];

  // a department is found by its code (CS) or by a word of its name (computer)
  const hits = departments.filter((d) => {
    const code = d.code.toLowerCase();
    const nameWords = d.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));
    return words.includes(code) || words.some((w) => w.length >= 4 && nameWords.some((n) => n.startsWith(w) || w.startsWith(n)));
  });
  const dept = hits.length === 1 ? hits[0] : null;
  const deptWords = new Set(dept ? [dept.code.toLowerCase(), ...dept.name.toLowerCase().split(/\s+/)] : []);

  const tokens = words.filter((w) => w.length >= 3 && !STOP.has(w) && !deptWords.has(w) && !/^\d+$/.test(w));
  return {
    semester: sem ? Number(sem[1] || sem[2]) : null,
    dept,
    tokens,
    wantsStudents: /\b(students?|roll|classmates?|admission)\b/.test(text),
    wantsTeachers: /\b(teachers?|faculty|staff|lecturers?|professors?|sir|madam)\b/.test(text),
    wantsDepartments: /\b(departments?|hods?|heads?)\b/.test(text),
  };
};

const subjectLine = (c) => `${c.code} ${c.title} (${c.semester?.name || ''}, sec ${c.section})`;

// Finds the people for one question. user must be an HOD or the University Head.
export const loadPeople = async (user, question) => {
  const isHod = user.role === ROLES.HOD;
  const all = await Department.find({ status: 'active' }).populate('hod', 'name email phone').select('name code hod').sort({ name: 1 }).lean();
  const departments = isHod ? all.filter((d) => String(d._id) === String(user.department)) : all;
  const q = parseQuestion(question, departments);
  const deptIds = (q.dept ? [q.dept] : departments).map((d) => d._id);
  const deptCode = new Map(all.map((d) => [String(d._id), d.code]));
  const nothingAsked = !q.wantsStudents && !q.wantsTeachers && !q.wantsDepartments && !q.tokens.length;

  // How many students per department and semester (always shown: it answers "how many")
  const [byDept, teacherCounts] = await Promise.all([
    StudentProfile.aggregate([
      { $match: { department: { $in: deptIds }, status: STUDENT_STATUS.ACTIVE } },
      { $group: { _id: { d: '$department', s: '$semester' }, n: { $sum: 1 } } },
    ]),
    User.aggregate([{ $match: { role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true, department: { $in: deptIds } } }, { $group: { _id: '$department', n: { $sum: 1 } } }]),
  ]);
  const semNames = new Map((await Semester.find({ _id: { $in: byDept.map((x) => x._id.s).filter(Boolean) } }).select('name number').lean()).map((s) => [String(s._id), s]));
  const tCount = new Map(teacherCounts.map((x) => [String(x._id), x.n]));
  const sCount = new Map();
  for (const x of byDept) sCount.set(String(x._id.d), (sCount.get(String(x._id.d)) || 0) + x.n);

  const data = {
    scope: isHod ? 'your department' : q.dept ? q.dept.name : 'the whole university',
    departments: departments.map((d) => ({ name: d.name, code: d.code, hod: d.hod ? `${d.hod.name} (${d.hod.email}${d.hod.phone ? `, ${d.hod.phone}` : ''})` : 'no HOD', teachers: tCount.get(String(d._id)) || 0, students: sCount.get(String(d._id)) || 0 })),
    perSemester: byDept
      .map((x) => ({ department: deptCode.get(String(x._id.d)), semester: semNames.get(String(x._id.s))?.name || 'no semester yet', number: semNames.get(String(x._id.s))?.number ?? 99, students: x.n }))
      .sort((a, b) => a.department.localeCompare(b.department) || a.number - b.number),
    teachers: [],
    students: [],
    studentsTotal: 0,
    matches: { students: [], teachers: [] },
    question: q,
  };

  // ----- teachers -----
  const nameRx = q.tokens.length ? new RegExp(q.tokens.map(esc).join('|'), 'i') : null;
  if (q.wantsTeachers || nothingAsked || nameRx) {
    const filter = { role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true, department: { $in: deptIds } };
    const listAll = q.wantsTeachers || nothingAsked;
    const people = await User.find(!listAll && nameRx ? { ...filter, name: nameRx } : filter).select('name email phone qualification role department').sort({ name: 1 }).limit(listAll ? 150 : 8).lean();
    const ids = people.map((t) => t._id);
    const [courses, slots] = await Promise.all([
      Course.find({ teacher: { $in: ids }, status: COURSE_STATUS.ACTIVE }).populate('semester', 'name').select('code title section teacher semester creditHours').lean(),
      TimetableSlot.aggregate([{ $match: { teacher: { $in: ids } } }, { $group: { _id: '$teacher', n: { $sum: 1 } } }]),
    ]);
    const weekly = new Map(slots.map((s) => [String(s._id), s.n]));
    const rows = people.map((t) => {
      const mine = courses.filter((c) => String(c.teacher) === String(t._id));
      return {
        name: t.name, role: t.role === ROLES.HOD ? 'HOD' : 'Teacher', department: deptCode.get(String(t.department)) || '', email: t.email, phone: t.phone || '', qualification: t.qualification || '',
        subjects: mine.map(subjectLine), creditHours: mine.reduce((n, c) => n + (c.creditHours || 0), 0), weeklyClasses: weekly.get(String(t._id)) || 0,
      };
    });
    if (listAll) data.teachers = rows; else data.matches.teachers = rows;
  }

  // ----- students -----
  if (q.wantsStudents || nameRx) {
    const filter = { department: { $in: deptIds }, status: STUDENT_STATUS.ACTIVE };
    if (q.semester) {
      filter.semester = { $in: await Semester.find({ department: { $in: deptIds }, number: q.semester }).distinct('_id') };
    }
    const shape = (p) => ({
      name: p.user?.name || '', roll: p.rollNumber, department: p.department?.code || '', semester: p.semester?.name || 'none', section: p.section,
      email: p.user?.email || '', phone: p.user?.phone || '', guardian: [p.guardianName, p.guardianPhone].filter(Boolean).join(', '), _id: p.user?._id,
    });
    const populate = (qry) => qry.populate('user', 'name email phone').populate('semester', 'name').populate('department', 'code');

    if (q.wantsStudents) {
      data.studentsTotal = await StudentProfile.countDocuments(filter);
      data.students = (await populate(StudentProfile.find(filter).sort({ rollNumber: 1 }).limit(300)).lean()).map(shape);
    } else {
      // asked by name or roll number: find those people and add their subjects with teachers
      const byName = await User.find({ role: ROLES.STUDENT, department: { $in: deptIds }, name: nameRx }).distinct('_id');
      const profiles = await populate(
        StudentProfile.find({ ...filter, $or: [{ user: { $in: byName } }, { rollNumber: { $in: q.tokens.map((t) => t.toUpperCase()) } }] }).limit(8)
      ).lean();
      for (const p of profiles) {
        const enr = await CourseEnrollment.find({ student: p.user._id, status: ENROLLMENT_STATUS.ENROLLED }).distinct('course');
        const courses = await Course.find({ _id: { $in: enr }, status: COURSE_STATUS.ACTIVE }).populate('teacher', 'name').populate('semester', 'name').select('code title section teacher semester').lean();
        data.matches.students.push({ ...shape(p), subjects: courses.map((c) => `${subjectLine(c)}, teacher ${c.teacher?.name || 'not assigned'}`) });
      }
    }
  }
  return data;
};

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

// The facts as text for the model (inside <people_data>).
export const peopleText = (d) => {
  const out = [`Scope: ${d.scope}`];
  out.push(`Departments:\n${d.departments.map((x) => `  ${x.name} (${x.code}): HOD ${x.hod}; ${x.teachers} teachers; ${x.students} students`).join('\n')}`);
  out.push(`Active students per semester:\n${d.perSemester.map((x) => `  ${x.department} ${x.semester}: ${x.students}`).join('\n') || '  none'}`);
  if (d.teachers.length) out.push(`Teachers (${d.teachers.length}):\n${d.teachers.map((t) => `  ${t.name} | ${t.role} | ${t.department} | ${t.qualification || 'no qualification'} | ${t.email} | ${t.phone || 'no phone'} | ${t.creditHours} credit hours, ${t.weeklyClasses} weekly classes | subjects: ${t.subjects.join('; ') || 'none'}`).join('\n')}`);
  if (d.students.length) out.push(`Students (${d.students.length} shown of ${d.studentsTotal}):\n${d.students.map((s) => `  ${s.name} | ${s.roll} | ${s.department} | ${s.semester} | sec ${s.section} | ${s.email} | ${s.phone || 'no phone'} | guardian: ${s.guardian || 'none'}`).join('\n')}`);
  for (const t of d.matches.teachers) out.push(`Teacher match: ${t.name} | ${t.role} | ${t.department} | ${t.qualification} | ${t.email} | ${t.phone} | subjects: ${t.subjects.join('; ') || 'none'}`);
  for (const s of d.matches.students) out.push(`Student match: ${s.name} | ${s.roll} | ${s.department} | ${s.semester} | sec ${s.section} | ${s.email} | ${s.phone} | guardian: ${s.guardian || 'none'} | subjects: ${s.subjects.join('; ') || 'none'}`);
  return out.join('\n\n').slice(0, 14000);
};

// Without an AI key the same data is shown as tables.
export const peopleFallback = (d) => {
  const out = [];
  if (d.matches.students.length) {
    out.push('### Students found');
    for (const s of d.matches.students) {
      out.push(`**${s.name}** (${s.roll}) · ${s.department} · ${s.semester} · section ${s.section}`, `- Email: ${s.email || '-'} · Phone: ${s.phone || '-'} · Guardian: ${s.guardian || '-'}`, ...s.subjects.map((x) => `- ${x}`), '');
    }
  }
  if (d.matches.teachers.length) {
    out.push('### Teachers found');
    out.push(table(['Name', 'Role', 'Dept', 'Qualification', 'Email', 'Phone', 'Subjects'], d.matches.teachers.map((t) => [t.name, t.role, t.department, t.qualification, t.email, t.phone, t.subjects.join('; ')])), '');
  }
  if (d.teachers.length) {
    out.push(`### Teachers (${d.teachers.length})`);
    out.push(table(['Name', 'Role', 'Dept', 'Qualification', 'Email', 'Phone', 'Credit hrs', 'Weekly classes', 'Subjects'], d.teachers.map((t) => [t.name, t.role, t.department, t.qualification, t.email, t.phone, t.creditHours, t.weeklyClasses, t.subjects.join('; ')])), '');
  }
  if (d.students.length) {
    out.push(`### Students (${d.students.length}${d.studentsTotal > d.students.length ? ` of ${d.studentsTotal}` : ''})`);
    out.push(table(['Name', 'Roll no', 'Dept', 'Semester', 'Section', 'Email', 'Phone'], d.students.map((s) => [s.name, s.roll, s.department, s.semester, s.section, s.email, s.phone])), '');
  }
  if (d.question.wantsDepartments || (!out.length)) {
    out.push('### Departments');
    out.push(table(['Department', 'HOD', 'Teachers', 'Students'], d.departments.map((x) => [`${x.name} (${x.code})`, x.hod, x.teachers, x.students])), '');
    if (d.perSemester.length) out.push('### Students per semester', ...d.perSemester.map((x) => `- ${x.department} · ${x.semester}: **${x.students}**`), '');
  }
  out.push('_The AI model is not switched on, so this is a direct list from the database. Add an AI key on the server to ask free questions about these people._');
  return out.join('\n');
};
