import Program from '../models/Program.js';
import Semester from '../models/Semester.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { reassignCourseSlots } from '../services/timetableService.js';
import { enrollInCourses } from '../services/enrollmentService.js';
import { notifyTeacherChange } from '../services/assignmentNotice.js';
import { normalizeCode } from '../services/curriculumService.js';
import { subjectsOf, createMissingClasses } from '../services/classService.js';
import { normalizeTitle, titleScore } from '../services/outlineService.js';
import TimetableSlot from '../models/TimetableSlot.js';
import { findBlockers } from '../utils/blockers.js';
import { eligibleTeacherQuery, teachesIn, assertWithinWeeklyLimit } from '../services/teacherService.js';
import { courseBlockerChecks, courseDataSummary, purgeCourse, purgeCourseDeep } from '../services/courseRemoval.js';
import { ROLES, COURSE_STATUS, STUDENT_STATUS, CLOSED_SEMESTER_STATES } from '../config/constants.js';

const loadSemester = async (id) => {
  const s = await Semester.findById(id).populate('department', 'name code');
  if (!s) throw ApiError.notFound('Semester not found');
  return s;
};

// ---------- The HOD's assignment board ----------
// For one semester of the HOD's department and one approved BS programme:
//   rows     = every subject of that semester of the programme, with the class(es) already created and their teacher
//   teachers = every active teacher of the department with qualification, contact details and current teaching load
// The principal may open the same board read-only.
export const board = asyncHandler(async (req, res) => {
  const semester = await loadSemester(req.query.semester);
  assertDepartmentAccess(req.user, semester.department._id);
  const deptId = semester.department._id;

  const programs = await Program.find({ department: deptId, status: 'active' }).sort({ name: 1 }).lean();
  const program = req.query.program
    ? programs.find((p) => String(p._id) === req.query.program)
    : programs.length === 1 ? programs[0] : null;
  if (req.query.program && !program) throw ApiError.notFound('Programme not found in this department');

  const subjects = subjectsOf(program, semester.number);
  const codes = subjects.map((s) => s.code);
  const [courses, teachers] = await Promise.all([
    Course.find({ semester: semester._id }).populate('teacher', 'name email').lean(),
    // The department's own teachers AND teachers of other departments who are allowed to teach here (common subjects).
    User.find(eligibleTeacherQuery(deptId)).select('name email phone qualification role subjects maxWeeklyHours department').populate('department', 'name code').sort({ name: 1 }).lean(),
  ]);

  const load = await Course.find({ teacher: { $in: teachers.map((t) => t._id) }, status: COURSE_STATUS.ACTIVE })
    .populate('semester', 'name number status')
    .lean();
  const open = load.filter((c) => c.semester && !CLOSED_SEMESTER_STATES.includes(c.semester.status));

  sendSuccess(res, {
    semester: { _id: semester._id, name: semester.name, number: semester.number, academicYear: semester.academicYear, status: semester.status, department: semester.department },
    programs: programs.map((p) => ({ _id: p._id, name: p.name, hasThisSemester: p.semesters.some((s) => s.number === semester.number) })),
    program: program ? { _id: program._id, name: program.name } : null,
    readOnly: req.user.role !== ROLES.HOD,
    rows: subjects.map((sub) => ({
      subject: sub,
      classes: courses
        .filter((c) => c.code === sub.code)
        .map((c) => ({ _id: c._id, section: c.section, status: c.status, weeklyClasses: c.weeklyClasses || null, teacher: c.teacher ? { _id: c.teacher._id, name: c.teacher.name } : null })),
    })),
    otherClasses: courses.filter((c) => !codes.includes(c.code)).length,
    teachers: teachers.map((t) => {
      const mine = open.filter((c) => String(c.teacher) === String(t._id));
      return {
        ...t,
        creditHours: mine.reduce((n, c) => n + (c.creditHours || 0), 0),
        weeklyHours: mine.reduce((n, c) => n + (c.weeklyClasses || c.creditHours || 0), 0), // classes per week, what the weekly limit is measured against
        home: String(t.department?._id) === String(deptId), // false = a teacher of another department who also teaches here
        assignments: mine.map((c) => ({ _id: c._id, code: c.code, title: c.title, section: c.section, creditHours: c.creditHours, semester: c.semester?.name })),
      };
    }),
  });
});

// ---------- Create ALL classes of a semester from the approved curriculum ----------
// The HOD picks a semester and a programme; every subject of that semester number becomes a class (Course) at once,
// for each requested section, without a teacher. Teachers are assigned afterwards on the same board (assignSubject below).
// Safe to run again: classes that already exist are left untouched. Students already placed in this semester and
// section are enrolled in each new class.
export const generateCourses = asyncHandler(async (req, res) => {
  const sections = [...new Set(req.body.sections)];
  const semester = await loadSemester(req.body.semester);
  assertDepartmentAccess(req.user, semester.department._id);
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) throw ApiError.badRequest(`This semester is ${semester.status}`);

  const program = await Program.findOne({ _id: req.body.program, department: semester.department._id, status: 'active' });
  if (!program) throw ApiError.notFound('Programme not found in your department');
  // "Offer all" means the compulsory subjects of the scheme. The elective options and the "Specialization Elective" slots
  // (CS67XX) are chosen one by one by the HOD (Offer ticked subjects / Replace).
  const subjects = subjectsOf(program, semester.number).filter((s) => !s.elective && !/XX/.test(s.code));
  if (!subjects.length) {
    throw ApiError.badRequest(`${program.name} has no compulsory subjects for semester ${semester.number}. Tick the electives you want to offer instead, or check that the semester number of ${semester.name} matches a semester of the curriculum`);
  }

  const { made, enrolled } = await createMissingClasses({ semester, program, subjects, sections, userId: req.user._id });

  const total = subjects.length * sections.length;
  logAudit(req, 'teaching.generate', 'Semester', semester._id, { program: program.name, sections, created: made.length, enrolled });
  sendSuccess(
    res,
    { created: made.length, alreadyExisted: total - made.length, subjects: subjects.length, sections, studentsEnrolled: enrolled },
    made.length ? `${made.length} class(es) created from the curriculum` : 'All classes of this semester already exist',
    made.length ? 201 : 200
  );
});

// ---------- Assign (or remove) the teacher of one subject ----------
// Creates the class (Course) from the approved curriculum the first time, enrols the students of that semester and
// section, and later changes simply replace the teacher. Teacher profile, department details and semester details all read
// the same Course document, so one save updates every screen.
export const assignSubject = asyncHandler(async (req, res) => {
  const { semester: semesterId, program: programId, section } = req.body;
  const code = normalizeCode(req.body.code);
  const semester = await loadSemester(semesterId);
  assertDepartmentAccess(req.user, semester.department._id);
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) throw ApiError.badRequest(`This semester is ${semester.status}`);

  const program = await Program.findOne({ _id: programId, department: semester.department._id, status: 'active' });
  if (!program) throw ApiError.notFound('Programme not found in your department');
  const subject = subjectsOf(program, semester.number).find((s) => s.code === code);
  if (!subject) throw ApiError.badRequest(`${code} is not a subject of semester ${semester.number} of ${program.name}`);

  let teacher = null;
  if (req.body.teacher) {
    teacher = await User.findById(req.body.teacher);
    if (!teacher || !teacher.isActive || ![ROLES.TEACHER, ROLES.HOD].includes(teacher.role)) throw ApiError.badRequest('Selected teacher not found or inactive');
    if (!teachesIn(teacher, semester.department._id)) throw ApiError.badRequest('This teacher does not work in this department. Add the department under the teacher\'s "Also teaches in" list (Users > Edit)');
  }

  let course = await Course.findOne({ semester: semester._id, code: subject.code, section });
  const created = !course;
  if (created) {
    if (!teacher) throw ApiError.badRequest('This subject has no class yet, so there is no teacher to remove');
    course = new Course({
      outline: subject.outline || '', // course contents from the curriculum
      title: subject.title,
      code: subject.code,
      creditHours: subject.creditHours,
      department: semester.department._id,
      semester: semester._id,
      program: program._id,
      section,
      startDate: semester.startDate,
      endDate: semester.endDate,
      createdBy: req.user._id,
    });
  } else if (course.status === COURSE_STATUS.ARCHIVED) {
    throw ApiError.badRequest('This class is archived. Activate it from Courses first');
  }

  // Classes per week: the HOD sets how often this subject is taught (empty = its credit hours). Then the teacher's weekly limit,
  // if the administrator set one, is checked against the real number of classes.
  if (req.body.weeklyClasses !== undefined) course.weeklyClasses = req.body.weeklyClasses;
  if (teacher && (created || String(course.teacher || '') !== String(teacher._id) || req.body.weeklyClasses !== undefined)) await assertWithinWeeklyLimit(teacher, course);

  const previous = course.teacher ? String(course.teacher) : null;
  const next = teacher ? String(teacher._id) : null;
  if (!created && previous !== next) await reassignCourseSlots(course, teacher?._id || null); // moves timetable slots, or refuses on a clash
  course.teacher = teacher?._id || null;
  if (!course.program) course.program = program._id;
  if (!course.outline && subject.outline) course.outline = subject.outline; // contents added to the curriculum after the class was created
  await course.save();

  let enrolled = 0;
  if (created) {
    const profiles = await StudentProfile.find({ semester: semester._id, section: course.section, status: STUDENT_STATUS.ACTIVE }).select('user').lean();
    enrolled = (await enrollInCourses(profiles.map((p) => p.user), [course], req.user._id)).enrolled;
  }

  if (previous !== next) {
    await notifyTeacherChange({ course, semesterName: semester.name, previous, next }); // subject, credits, section, students and course contents
  }
  logAudit(req, 'teaching.assign', 'Course', course._id, { code: course.code, semester: semester.name, from: previous, to: next, created, enrolled });

  sendSuccess(res, {
    class: { _id: course._id, section: course.section, status: course.status, teacher: teacher ? { _id: teacher._id, name: teacher.name } : null },
    created,
    studentsEnrolled: enrolled,
  }, teacher ? (created ? 'Class created and teacher assigned' : 'Teacher assigned') : 'Teacher removed', created ? 201 : 200);
});

// ---------- Choose WHICH subjects are offered ----------
// A later semester can list many subjects (for example 21 in semester 7) of which the HOD offers only five or six.
// Only the chosen subjects become classes, so only they appear under Courses, on the timetable and to students.
const loadOpenSemester = async (id, user) => {
  const semester = await loadSemester(id);
  assertDepartmentAccess(user, semester.department._id);
  if (CLOSED_SEMESTER_STATES.includes(semester.status)) throw ApiError.badRequest(`This semester is ${semester.status}`);
  return semester;
};
const loadProgram = async (id, semester) => {
  const program = await Program.findOne({ _id: id, department: semester.department._id, status: 'active' });
  if (!program) throw ApiError.notFound('Programme not found in your department');
  return program;
};

// What is inside each class (attendance, assignments, quizzes ...). Nothing is changed.
const previewTakeOut = async (courses) => {
  const out = [];
  for (const c of courses) {
    const s = await courseDataSummary(c);
    out.push({ code: c.code, title: c.title, section: c.section, hasRecords: s.hasRecords, items: s.items, blocked: s.blocked });
  }
  return out;
};

// A class with records is only deleted after the HOD confirmed it in the window (the page then sends force = true).
// Checked BEFORE anything is changed, so a refusal never leaves the semester half done.
const assertConfirmed = async (courses, force) => {
  if (force) return;
  const withData = [];
  for (const c of courses) {
    const s = await courseDataSummary(c);
    if (!s.blocked && s.hasRecords) withData.push(`${c.code} (Sec ${c.section}): ${s.items.map((i) => `${i.count} ${i.label}`).join(', ')}`);
  }
  if (withData.length) throw ApiError.conflict(`These subjects already have records: ${withData.join('; ')}. Confirm to delete them together with their records.`);
};

// Takes classes out of a semester so that nothing of them stays on the timetable.
//   no real records  -> deleted completely (timetable slots and enrollments go with it)
//   has real records -> archived: its attendance / marks stay for the history, but its timetable slots are removed
const takeOut = async (courses, semesterName, { force = false } = {}) => {
  await assertConfirmed(courses, force);
  const out = { removed: 0, archived: [] };
  for (const c of courses) {
    // Saved results are official records: such a class is never deleted, it is archived (its timetable slots still go).
    const info = await courseDataSummary(c);
    const blockers = info.blocked ? [[1, 'saved result record(s)']] : [];
    if (blockers.length) {
      await TimetableSlot.deleteMany({ course: c._id });
      await Course.updateOne({ _id: c._id }, { status: COURSE_STATUS.ARCHIVED });
      out.archived.push({ code: c.code, section: c.section, because: blockers.map(([n, label]) => `${n} ${label}`).join(', ') });
    } else {
      if (info.hasRecords) await purgeCourseDeep(c); // confirmed by the HOD (force): the subject and all its records
      else await purgeCourse(c);
      out.removed += 1;
    }
    if (c.teacher) {
      await notifyUsers([c.teacher], { title: 'Subject removed from your classes', message: `${c.code} ${c.title} (section ${c.section}) is no longer offered in ${semesterName}. It was removed from your timetable.`, type: 'timetable', link: '/my-timetable' });
    }
  }
  return out;
};

export const offerSubjects = asyncHandler(async (req, res) => {
  const semester = await loadOpenSemester(req.body.semester, req.user);
  const program = await loadProgram(req.body.program, semester);
  const wanted = new Set(req.body.codes.map(normalizeCode));
  const chosen = subjectsOf(program, semester.number).filter((s) => wanted.has(s.code));
  if (!chosen.length) throw ApiError.badRequest('None of the chosen subjects belongs to this semester of the curriculum');

  const { made, enrolled } = await createMissingClasses({ semester, program, subjects: chosen, sections: [...new Set(req.body.sections)], userId: req.user._id });
  logAudit(req, 'teaching.offer', 'Semester', semester._id, { subjects: chosen.map((s) => s.code), created: made.length, enrolled });
  sendSuccess(res, { created: made.length, subjects: chosen.length, studentsEnrolled: enrolled }, made.length ? `${made.length} class(es) created for the chosen subjects` : 'These subjects are already offered', made.length ? 201 : 200);
});

// Stop offering a subject: its class(es) leave Courses and the timetable.
export const withdrawSubject = asyncHandler(async (req, res) => {
  const semester = await loadOpenSemester(req.body.semester, req.user);
  await loadProgram(req.body.program, semester);
  const code = normalizeCode(req.body.code);
  const courses = await Course.find({ semester: semester._id, code }).lean();
  if (!courses.length) throw ApiError.notFound('This subject has no class in the semester');
  if (req.body.preview) return sendSuccess(res, { classes: await previewTakeOut(courses) }, 'Nothing was changed');
  const r = await takeOut(courses, semester.name, { force: req.body.force });
  logAudit(req, 'teaching.withdraw', 'Semester', semester._id, { code, removed: r.removed, archived: r.archived.length });
  sendSuccess(res, r, `${code} is no longer offered in ${semester.name}`);
});

// Swap an offered subject for another subject of the same semester of the curriculum. The old class is taken out of Courses
// AND the timetable (nothing of it remains there). The new class is created for the same sections and, if asked,
// keeps the same teacher. The HOD then schedules the new class on the timetable.
export const replaceSubject = asyncHandler(async (req, res) => {
  const semester = await loadOpenSemester(req.body.semester, req.user);
  const program = await loadProgram(req.body.program, semester);
  const from = normalizeCode(req.body.from);
  const subjects = subjectsOf(program, semester.number);
  const target = subjects.find((s) => s.code === normalizeCode(req.body.to));
  if (!target) throw ApiError.badRequest('The new subject is not part of this semester of the curriculum');
  if (target.code === from) throw ApiError.badRequest('Choose a different subject to replace it with');

  const oldCourses = await Course.find({ semester: semester._id, code: from }).lean();
  if (!oldCourses.length) throw ApiError.notFound(`${from} has no class in this semester`);
  const sections = [...new Set(oldCourses.map((c) => c.section))];
  const teacherOf = new Map(oldCourses.filter((c) => c.teacher).map((c) => [c.section, c.teacher]));

  const removed = await takeOut(oldCourses, semester.name, { force: req.body.force });
  const { made, enrolled } = await createMissingClasses({ semester, program, subjects: [target], sections, userId: req.user._id });

  if (req.body.keepTeacher) {
    for (const c of made) {
      const t = teacherOf.get(c.section);
      if (!t) continue;
      c.teacher = t;
      await c.save();
      await notifyTeacherChange({ course: c, semesterName: semester.name, previous: null, next: String(t) });
    }
  }
  logAudit(req, 'teaching.replace', 'Semester', semester._id, { from, to: target.code, created: made.length, removed: removed.removed, archived: removed.archived.length });
  sendSuccess(res, { created: made.length, studentsEnrolled: enrolled, ...removed }, `${from} replaced by ${target.code}. The old class was removed from the timetable`);
});

// ---------- Make ONE semester match the curriculum ----------
// The HOD says "semester 5 must have exactly the 5 subjects of the curriculum". This compares the classes of the semester with
// the subjects of that semester in the approved curriculum and:
//   keeps    classes that match a subject (matched by code, then by subject name)
//   fixes    their code / name / credit hours / course contents when they differ from the curriculum
//   removes  classes that are not a subject of this semester, and duplicates. A class with real records (attendance, marks ...)
//            is archived instead, so no history is lost. Its timetable classes are removed either way.
//   adds     compulsory subjects that have no class yet (never the elective options: the HOD offers those one by one)
// With apply=false nothing changes: it only returns the plan, so the HOD can read it before confirming.
export const matchSemester = asyncHandler(async (req, res) => {
  const semester = await loadOpenSemester(req.body.semester, req.user);
  const all = (await Program.find({ department: semester.department._id, status: 'active' }).lean()).filter((p) => subjectsOf(p, semester.number).length);
  const program = req.body.program ? all.find((p) => String(p._id) === req.body.program) : all.length === 1 ? all[0] : null;
  if (!program) {
    throw ApiError.badRequest(all.length
      ? 'Choose the BS programme of this semester'
      : `No approved BS programme has a semester ${semester.number}. The principal uploads the curriculum under "BS Curriculum"`);
  }
  const subjects = subjectsOf(program, semester.number);
  const scheme = subjects.filter((s) => !s.elective && !/XX/.test(s.code));

  const courses = await Course.find({ semester: semester._id }).populate('teacher', 'name').lean();
  const sections = [...new Set(courses.filter((c) => c.status !== COURSE_STATUS.ARCHIVED).map((c) => c.section))];
  if (!sections.length) sections.push('A');

  // which curriculum subject is this class? code first, then subject name
  const subjectOf = (c) => {
    const byCode = subjects.find((s) => s.code === normalizeCode(c.code));
    if (byCode) return byCode;
    const title = normalizeTitle(c.title);
    let best = null;
    for (const s of subjects) {
      const sc = titleScore(title, normalizeTitle(s.title));
      if (sc >= 2 && (!best || sc > best.sc)) best = { s, sc };
    }
    return best?.s || null;
  };

  const live = courses.filter((c) => c.status !== COURSE_STATUS.ARCHIVED);
  const winners = new Map(); // "subject code:section" -> { c, sub }
  const drop = []; // { course, reason }
  for (const c of live) {
    const sub = subjectOf(c);
    if (!sub) { drop.push({ course: c, reason: `not a subject of semester ${semester.number} in the curriculum` }); continue; }
    const key = `${sub.code}:${c.section}`;
    const have = winners.get(key);
    if (!have) { winners.set(key, { c, sub }); continue; }
    // two classes for the same subject and section: keep the one that already has a teacher
    if (!have.c.teacher && c.teacher) { drop.push({ course: have.c, reason: `duplicate of ${sub.code}` }); winners.set(key, { c, sub }); }
    else drop.push({ course: c, reason: `duplicate of ${sub.code}` });
  }

  const fix = [];
  for (const { c, sub } of winners.values()) {
    const patch = {};
    if (c.code !== sub.code) patch.code = sub.code;
    if (c.title !== sub.title) patch.title = sub.title;
    if (c.creditHours !== sub.creditHours) patch.creditHours = sub.creditHours;
    if (sub.outline && (req.body.replaceContents ? c.outline !== sub.outline : !String(c.outline || '').trim())) patch.outline = sub.outline;
    if (Object.keys(patch).length) fix.push({ course: c, patch });
  }

  const covered = new Set(courses.map((c) => subjectOf(c)?.code).filter(Boolean));
  const missing = scheme.filter((s) => !covered.has(s.code));

  const dropInfo = [];
  for (const d of drop) {
    const info = await courseDataSummary(d.course);
    dropInfo.push({ ...d, archive: !!info.blocked, hasRecords: info.hasRecords, items: info.items, because: info.blocked ? 'saved results' : info.items.map((i) => `${i.count} ${i.label}`).join(', ') });
  }

  const plan = {
    program: { _id: program._id, name: program.name },
    semesterNumber: semester.number,
    expected: scheme.length,
    keep: [...winners.values()].filter(({ c }) => !fix.some((f) => String(f.course._id) === String(c._id))).map(({ c }) => ({ code: c.code, title: c.title, section: c.section, teacher: c.teacher?.name || null })),
    fix: fix.map((f) => ({ code: f.course.code, title: f.course.title, section: f.course.section, changes: Object.keys(f.patch), to: { code: f.patch.code || f.course.code, title: f.patch.title || f.course.title, creditHours: f.patch.creditHours ?? f.course.creditHours } })),
    remove: dropInfo.map((d) => ({ code: d.course.code, title: d.course.title, section: d.course.section, teacher: d.course.teacher?.name || null, reason: d.reason, archive: d.archive, hasRecords: d.hasRecords, items: d.items, because: d.because })),
    add: missing.map((s) => ({ code: s.code, title: s.title, creditHours: s.creditHours })),
    sections,
  };
  if (!req.body.apply) return sendSuccess(res, plan, 'Plan ready. Nothing was changed yet');

  // 1. remove first, so a corrected code can never collide with a class that is about to disappear
  const removed = dropInfo.length ? await takeOut(dropInfo.map((d) => ({ ...d.course, teacher: d.course.teacher?._id || null })), semester.name, { force: req.body.force }) : { removed: 0, archived: [] };
  // 2. fix the classes that stay
  let fixed = 0;
  for (const f of fix) {
    try { await Course.updateOne({ _id: f.course._id }, f.patch); fixed += 1; } catch (err) { if (err.code !== 11000) throw err; }
  }
  // 3. add the compulsory subjects that had no class
  const { made, enrolled } = missing.length
    ? await createMissingClasses({ semester, program, subjects: missing, sections, userId: req.user._id })
    : { made: [], enrolled: 0 };

  logAudit(req, 'teaching.match', 'Semester', semester._id, { program: program.name, removed: removed.removed, archived: removed.archived.length, fixed, added: made.length });
  sendSuccess(res, { ...plan, result: { removed: removed.removed, archived: removed.archived, fixed, added: made.length, studentsEnrolled: enrolled } },
    `${semester.name} now matches the curriculum: ${removed.removed + removed.archived.length} removed, ${fixed} corrected, ${made.length} added`);
});
