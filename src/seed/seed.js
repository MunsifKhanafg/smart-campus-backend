import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import UniversitySettings from '../models/UniversitySettings.js';
import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import StudentProfile from '../models/StudentProfile.js';
import { autoEnrollSemester } from '../services/enrollmentService.js';
import CourseTopic from '../models/CourseTopic.js';
import Assignment from '../models/Assignment.js';
import { ROLES } from '../config/constants.js';

// Safe to run many times: it only creates what is missing.
await connectDB();

await UniversitySettings.getSettings();

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
  console.log(`Created University Head: ${headEmail}`);
}

let dept = await Department.findOne({ code: 'CS' });
if (!dept) {
  dept = await Department.create({
    name: 'Computer Science',
    code: 'CS',
    description: 'Demo department',
    createdBy: head._id,
  });
  const hod = await User.create({
    name: 'Demo HOD',
    email: 'hod.cs@university.edu',
    password: 'ChangeMe@12345',
    role: ROLES.HOD,
    department: dept._id,
    mustChangePassword: true,
  });
  dept.hod = hod._id;
  dept.hodHistory.push({ user: hod._id, from: new Date() });
  await dept.save();

  await User.create({
    name: 'Demo Teacher',
    email: 'teacher.cs@university.edu',
    password: 'ChangeMe@12345',
    role: ROLES.TEACHER,
    department: dept._id,
    mustChangePassword: true,
  });
  console.log('Created demo department CS with HOD and teacher (password: ChangeMe@12345)');
}

// Demo semester + course (Phase 2) so the HOD and teacher screens have something to show.
const csDept = await Department.findOne({ code: 'CS' });
if (csDept && !(await Semester.findOne({ department: csDept._id }))) {
  const demoHod = await User.findOne({ email: 'hod.cs@university.edu' });
  const demoTeacher = await User.findOne({ email: 'teacher.cs@university.edu' });
  const year = new Date().getFullYear();
  const sem = await Semester.create({
    department: csDept._id,
    name: 'BSCS Semester 1',
    number: 1,
    academicYear: `${year}-${year + 1}`,
    startDate: new Date(`${year}-09-01`),
    endDate: new Date(`${year + 1}-01-31`),
    status: 'active',
    createdBy: demoHod?._id,
  });
  await Course.create({
    title: 'Programming Fundamentals',
    code: 'CS-101',
    department: csDept._id,
    semester: sem._id,
    creditHours: 3,
    section: 'A',
    teacher: demoTeacher?._id,
    startDate: sem.startDate,
    endDate: sem.endDate,
    createdBy: demoHod?._id,
  });
  console.log('Created demo semester and course CS-101');
}

// Phase 3-6 demo data: a finance officer, two students placed in the demo semester, and a draft fee notice.
if (!(await User.findOne({ email: 'finance@university.edu' }))) {
  await User.create({
    name: 'Demo Finance Officer',
    email: 'finance@university.edu',
    password: 'ChangeMe@12345',
    role: ROLES.FINANCE_OFFICER,
    mustChangePassword: true,
  });
  console.log('Created finance officer: finance@university.edu');
}

const demoSem = csDept ? await Semester.findOne({ department: csDept._id }) : null;
if (csDept && demoSem && !(await StudentProfile.findOne({ department: csDept._id }))) {
  const demoHod2 = await User.findOne({ email: 'hod.cs@university.edu' });
  const profiles = [];
  for (const [i, name] of ['Ali Khan', 'Sara Ahmed'].entries()) {
    const u = await User.create({
      name,
      email: `student${i + 1}@university.edu`,
      password: 'ChangeMe@12345',
      role: ROLES.STUDENT,
      department: csDept._id,
      mustChangePassword: true,
    });
    profiles.push(
      await StudentProfile.create({
        user: u._id,
        rollNumber: `CS-${new Date().getFullYear()}-00${i + 1}`,
        department: csDept._id,
        semester: demoSem._id,
        section: 'A',
        dateOfBirth: new Date('2004-05-15'),
        createdBy: demoHod2?._id,
      })
    );
  }
  await autoEnrollSemester(profiles, demoSem._id, demoHod2?._id);
  console.log('Created demo students student1@university.edu and student2@university.edu (DOB 2004-05-15)');
}

// ---- Demo students: every semester gets 10 students (placeholders the HOD replaces later) ----
// Safe to repeat: a semester that already has 10 or more students is skipped.
const FIRST = ['Ali', 'Sara', 'Ahmed', 'Fatima', 'Usman', 'Ayesha', 'Hamza', 'Zainab', 'Bilal', 'Maryam', 'Hassan', 'Hira', 'Omar', 'Noor', 'Talha', 'Iqra', 'Saad', 'Amna', 'Danish', 'Mahnoor'];
const LAST = ['Khan', 'Ahmed', 'Shah', 'Ali', 'Malik', 'Hussain', 'Iqbal', 'Raza', 'Yousaf', 'Afridi'];
const PER_SEMESTER = 10;
const allSemesters = await Semester.find({ status: { $nin: ['completed', 'archived'] } }).populate('department', 'code').sort({ department: 1, number: 1 });
for (const s of allSemesters) {
  const have = await StudentProfile.countDocuments({ semester: s._id });
  if (have >= PER_SEMESTER || !s.department) continue;
  const code = s.department.code;
  const added = [];
  for (let n = 1; n <= PER_SEMESTER; n += 1) {
    const tag = `${code.toLowerCase()}.s${s.number}.${String(n).padStart(2, '0')}`;
    const email = `${tag}@university.edu`;
    if (await User.findOne({ email })) continue;
    const i = (s.number * 7 + n * 3) % FIRST.length;
    const u = await User.create({
      name: `${FIRST[i]} ${LAST[(n + s.number) % LAST.length]}`,
      email,
      password: 'ChangeMe@12345',
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
  }
  if (added.length) {
    await autoEnrollSemester(added, s._id, head._id);
    console.log(`Added ${added.length} demo students to ${code} ${s.name} (login: <email> / ChangeMe@12345)`);
  }
}

// ---- Phase 4 demo data: a released topic, an upcoming topic and an assignment ----
const demoCourse = demoSem && (await Course.findOne({ semester: demoSem._id }));
if (demoCourse && !(await CourseTopic.findOne({ course: demoCourse._id }))) {
  const now = Date.now();
  const base = { course: demoCourse._id, department: demoCourse.department, semester: demoCourse.semester };
  await CourseTopic.create([
    { ...base, title: 'Introduction to programming', description: 'What is a program? Variables and data types.', scheduledDate: new Date(now - 7 * 864e5) },
    { ...base, title: 'Loops and conditions', description: 'if, for and while.', scheduledDate: new Date(now + 7 * 864e5) },
  ]);
  await Assignment.create({
    ...base, title: 'Assignment 1', description: 'Write three small programs.', releaseDate: new Date(now - 2 * 864e5), deadline: new Date(now + 5 * 864e5), maxMarks: 10,
  });
  console.log('Created demo topics and assignment');
}

console.log('Seed complete');
await mongoose.connection.close();
