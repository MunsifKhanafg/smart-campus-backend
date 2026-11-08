import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import StudentProfile from '../models/StudentProfile.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { autoEnrollSemester } from '../services/enrollmentService.js';
import { ROLES } from '../config/constants.js';

// ==========================================================================================================
// DEMO DATA:  npm run seed:demo
//   every active department gets: 1 HOD + 3 teachers (each with their OWN email and password),
//   3 semesters (1, 3 and 5), 2 courses per semester taught by those teachers, and 10 students per semester.
// Safe to run again: it only creates what is missing, it never changes an existing account or password.
// The emails and passwords are written to  server/demo-credentials.txt  (keep that file private, delete it when you are done).
// Every demo account must choose a new password at its first login.
// ==========================================================================================================

const STUDENT_PASSWORD = 'ChangeMe@12345';
const SEMESTERS = [1, 3, 5];
const DEFAULT_DEPARTMENTS = [
  ['Computer Science', 'CS'],
  ['Software Engineering', 'SE'],
  ['Information Technology', 'IT'],
];
const HOD_NAMES = ['Dr. Imran Qureshi', 'Dr. Saima Rehman', 'Dr. Tariq Mehmood', 'Dr. Nadia Farooq', 'Dr. Kamran Sheikh', 'Dr. Rabia Siddiqui'];
const TEACHER_NAMES = ['Mr. Farhan Ali', 'Ms. Sana Javed', 'Mr. Adeel Butt', 'Ms. Hina Aslam', 'Mr. Waqar Hussain', 'Ms. Komal Riaz', 'Mr. Rashid Mehmood', 'Ms. Laiba Noor', 'Mr. Junaid Akram', 'Ms. Sadia Pervez', 'Mr. Faisal Rauf', 'Ms. Mehwish Tariq'];
const COURSE_TITLES = ['Programming Fundamentals', 'Calculus', 'Data Structures', 'Database Systems', 'Operating Systems', 'Computer Networks', 'Software Engineering', 'Discrete Mathematics', 'Web Technologies', 'Artificial Intelligence', 'Theory of Automata', 'Human Computer Interaction'];
const FIRST = ['Ali', 'Sara', 'Ahmed', 'Fatima', 'Usman', 'Ayesha', 'Hamza', 'Zainab', 'Bilal', 'Maryam', 'Hassan', 'Hira', 'Omar', 'Noor', 'Talha', 'Iqra', 'Saad', 'Amna', 'Danish', 'Mahnoor'];
const LAST = ['Khan', 'Ahmed', 'Shah', 'Ali', 'Malik', 'Hussain', 'Iqbal', 'Raza', 'Yousaf', 'Afridi'];

await connectDB();
await UniversitySettings.getSettings();

const creds = []; // { dept, role, name, email, password }  (password null = account already existed)
const log = (msg) => console.log(msg);

// ---- the University Head and the finance officer ----
const headEmail = (process.env.SEED_PRINCIPAL_EMAIL || 'principal@university.edu').toLowerCase();
let head = await User.findOne({ email: headEmail });
if (!head) {
  head = await User.create({
    name: process.env.SEED_PRINCIPAL_NAME || 'University Head',
    email: headEmail,
    password: process.env.SEED_PRINCIPAL_PASSWORD || 'ChangeMe@12345',
    role: ROLES.UNIVERSITY_HEAD,
    mustChangePassword: true,
  });
  creds.push({ dept: 'University', role: 'University Head', name: head.name, email: headEmail, password: process.env.SEED_PRINCIPAL_PASSWORD || 'ChangeMe@12345' });
} else {
  creds.push({ dept: 'University', role: 'University Head', name: head.name, email: headEmail, password: null });
}

const financeEmail = 'finance@university.edu';
if (!(await User.findOne({ email: financeEmail }))) {
  await User.create({ name: 'Finance Officer', email: financeEmail, password: 'Finance@2026#', role: ROLES.FINANCE_OFFICER, mustChangePassword: true });
  creds.push({ dept: 'University', role: 'Finance Officer', name: 'Finance Officer', email: financeEmail, password: 'Finance@2026#' });
} else {
  creds.push({ dept: 'University', role: 'Finance Officer', name: 'Finance Officer', email: financeEmail, password: null });
}

// ---- departments: every active one, plus a few defaults when the university has fewer than three ----
let departments = await Department.find({ status: 'active' }).sort({ code: 1 });
if (departments.length < 3) {
  for (const [name, code] of DEFAULT_DEPARTMENTS) {
    if (departments.length >= 3) break;
    if (departments.some((d) => d.code === code)) continue;
    if (await Department.findOne({ $or: [{ code }, { name }] })) continue;
    departments.push(await Department.create({ name, code, description: 'Demo department', createdBy: head._id }));
    log(`Created department ${code}`);
  }
}

const year = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1; // academic year starts in September
let nameIndex = 0;

for (const dept of departments) {
  const code = dept.code;
  const lc = code.toLowerCase();

  // ---- HOD ----
  let hod = dept.hod ? await User.findById(dept.hod) : null;
  if (!hod) {
    const email = `hod.${lc}@university.edu`;
    hod = await User.findOne({ email });
    const password = `Hod@${code}#2026`;
    if (!hod) {
      hod = await User.create({ name: HOD_NAMES[nameIndex % HOD_NAMES.length], email, password, role: ROLES.HOD, department: dept._id, qualification: 'PhD', mustChangePassword: true });
      creds.push({ dept: code, role: 'HOD', name: hod.name, email, password });
    } else {
      creds.push({ dept: code, role: 'HOD', name: hod.name, email, password: null });
    }
    dept.hod = hod._id;
    dept.hodHistory.push({ user: hod._id, from: new Date() });
    await dept.save();
  } else {
    creds.push({ dept: code, role: 'HOD', name: hod.name, email: hod.email, password: null });
  }

  // ---- 3 teachers (at least; real teachers that already exist count) ----
  const existing = await User.find({ department: dept._id, role: ROLES.TEACHER }).sort({ createdAt: 1 });
  const teachers = [...existing];
  for (const t of existing) creds.push({ dept: code, role: 'Teacher', name: t.name, email: t.email, password: null });
  for (let n = 1; teachers.length < 3; n += 1) {
    const email = `teacher${n}.${lc}@university.edu`;
    if (await User.findOne({ email })) continue; // taken (for example a deactivated account), try the next number
    const password = `Teach@${code}${n}#2026`;
    const t = await User.create({
      name: TEACHER_NAMES[(nameIndex * 3 + teachers.length) % TEACHER_NAMES.length],
      email,
      password,
      role: ROLES.TEACHER,
      department: dept._id,
      qualification: 'MS',
      mustChangePassword: true,
    });
    teachers.push(t);
    creds.push({ dept: code, role: 'Teacher', name: t.name, email, password });
  }

  // ---- 3 semesters, 2 courses each ----
  for (const num of SEMESTERS) {
    const name = `BS${code} Semester ${num}`;
    let sem = await Semester.findOne({ department: dept._id, number: num, status: { $nin: ['completed', 'archived'] } });
    if (!sem) {
      sem = await Semester.create({
        department: dept._id,
        name,
        number: num,
        academicYear: `${year}-${year + 1}`,
        startDate: new Date(`${year}-09-01`),
        endDate: new Date(`${year + 1}-01-31`),
        status: 'active',
        createdBy: hod._id,
      });
      log(`Created ${code} semester ${num}`);
    }
    for (let k = 1; k <= 2; k += 1) {
      const courseCode = `${code}-${num}0${k}`;
      if (await Course.findOne({ semester: sem._id, code: courseCode, section: 'A' })) continue;
      await Course.create({
        title: COURSE_TITLES[((num - 1) * 2 + k - 1 + nameIndex) % COURSE_TITLES.length],
        code: courseCode,
        department: dept._id,
        semester: sem._id,
        creditHours: 3,
        section: 'A',
        teacher: teachers[(num + k) % teachers.length]._id,
        startDate: sem.startDate,
        endDate: sem.endDate,
        createdBy: hod._id,
      });
    }
  }
  nameIndex += 1;
}

// ---- 10 students in every running semester of those departments ----
const sems = await Semester.find({ department: { $in: departments.map((d) => d._id) }, status: { $nin: ['completed', 'archived'] } })
  .populate('department', 'code')
  .sort({ department: 1, number: 1 });
for (const s of sems) {
  const have = await StudentProfile.countDocuments({ semester: s._id });
  if (have >= 10) continue;
  const code = s.department.code;
  const added = [];
  for (let n = 1; n <= 10; n += 1) {
    const email = `${code.toLowerCase()}.s${s.number}.${String(n).padStart(2, '0')}@university.edu`;
    if (await User.findOne({ email })) continue;
    const i = (s.number * 7 + n * 3) % FIRST.length;
    const u = await User.create({
      name: `${FIRST[i]} ${LAST[(n + s.number) % LAST.length]}`,
      email,
      password: STUDENT_PASSWORD,
      role: ROLES.STUDENT,
      department: s.department._id,
      mustChangePassword: true,
    });
    added.push(
      await StudentProfile.create({
        user: u._id,
        rollNumber: `${code}-S${s.number}-${String(n).padStart(2, '0')}`,
        department: s.department._id,
        semester: s._id,
        section: 'A',
        dateOfBirth: new Date('2004-05-15'),
        createdBy: head._id,
      })
    );
    creds.push({ dept: code, role: `Student (semester ${s.number})`, name: u.name, email, password: STUDENT_PASSWORD, roll: `${code}-S${s.number}-${String(n).padStart(2, '0')}` });
  }
  if (added.length) {
    await autoEnrollSemester(added, s._id, head._id);
    log(`Added ${added.length} students to ${code} semester ${s.number}`);
  }
}

// ---- the credentials file ----
const lines = [
  'SMART CAMPUS - DEMO LOGINS',
  `Created ${new Date().toLocaleString()}. Keep this file private and delete it when you no longer need it.`,
  'Everybody must choose a new password at the first login. A password shown as "(unchanged)" belongs to an account that already existed: it is not stored anywhere, so use "Reset password" in Users if it was forgotten.',
  'Students: roll numbers are shown, date of birth for "Check result" is 2004-05-15.',
  '',
];
const groups = [...new Set(creds.map((c) => c.dept))];
for (const g of groups) {
  lines.push(`=== ${g} ===`);
  for (const c of creds.filter((x) => x.dept === g)) {
    lines.push(`${c.role.padEnd(22)} ${c.name.padEnd(24)} ${c.email.padEnd(36)} ${c.password ?? '(unchanged)'}${c.roll ? `   roll ${c.roll}` : ''}`);
  }
  lines.push('');
}
const file = path.resolve('demo-credentials.txt');
fs.writeFileSync(file, lines.join('\n'));
log(`\nDone. All logins are listed in ${file}`);
await mongoose.connection.close();
