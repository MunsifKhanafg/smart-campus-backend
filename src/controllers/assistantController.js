import AIConversation from '../models/AIConversation.js';
import Course from '../models/Course.js';
import User from '../models/User.js';
import StudentProfile from '../models/StudentProfile.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { getCourseFor, enrolledStudentIds, studentCourseIds } from '../services/accessService.js';
import { answerFromMaterials, callLLM, llmConfigured } from '../services/aiService.js';
import { computeCourseMetrics, revisionTopics } from '../services/performanceService.js';
import { ROLES } from '../config/constants.js';

const DISCLAIMER = 'This is automated guidance to help you study. It does not change your marks, grades, admission or promotion. Those decisions stay with the university staff.';

// ---------- Course assistant (RAG) ----------
export const ask = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.body.course, 'any'); // student must be enrolled, teacher must be assigned
  let convo = null;
  if (req.body.conversationId) {
    convo = await AIConversation.findOne({ _id: req.body.conversationId, user: req.user._id, course: course._id });
    if (!convo) throw ApiError.notFound('Conversation not found');
  }
  const result = await answerFromMaterials({
    question: req.body.question,
    courseIds: [course._id],
    history: convo?.messages || [],
    includeUnreleased: req.user.role !== ROLES.STUDENT, // a student never sees topics that are not released yet
  });

  convo = convo || new AIConversation({ user: req.user._id, course: course._id, title: req.body.question.slice(0, 80) });
  convo.messages.push({ role: 'user', content: req.body.question });
  convo.messages.push({ role: 'assistant', content: result.answer, sources: result.sources, grounded: result.grounded });
  await convo.save();
  sendSuccess(res, { conversationId: convo._id, answer: result.answer, grounded: result.grounded, sources: result.sources });
});

export const listConversations = asyncHandler(async (req, res) => {
  const filter = { user: req.user._id };
  if (req.query.course) filter.course = req.query.course;
  sendSuccess(res, await AIConversation.find(filter).select('title course mode updatedAt').sort({ updatedAt: -1 }).limit(50));
});

export const getConversation = asyncHandler(async (req, res) => {
  const convo = await AIConversation.findOne({ _id: req.params.id, user: req.user._id });
  if (!convo) throw ApiError.notFound('Conversation not found');
  sendSuccess(res, convo);
});

// ---------- Academic performance support (advice only) ----------
const studyPlanText = async (courses) => {
  if (!llmConfigured() || !courses.length) return null;
  try {
    const facts = courses.map((c) => ({ course: c.course.code, level: c.level, indicators: c.flags.map((f) => f.message), topics: c.revise }));
    return await callLLM({
      system: 'You are a supportive academic advisor. Write a short (under 120 words), encouraging study plan from the facts given. Give recommendations only. Never mention or promise marks, grades, admission or promotion decisions.',
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
      maxTokens: 400,
    });
  } catch {
    return null; // the rule-based indicators are still shown
  }
};

// The student's own summary across the courses of the current semester.
export const myPerformance = asyncHandler(async (req, res) => {
  const profile = await StudentProfile.findOne({ user: req.user._id }).select('semester');
  const courseIds = profile?.semester ? await studentCourseIds(req.user._id, profile.semester) : [];
  const courses = await Course.find({ _id: { $in: courseIds } }).select('code title section');

  const rows = [];
  for (const course of courses) {
    const m = (await computeCourseMetrics(course, [req.user._id])).get(String(req.user._id));
    rows.push({ course: { _id: course._id, code: course.code, title: course.title }, ...m, revise: m.level === 'low' ? [] : await revisionTopics(course._id) });
  }
  const needsHelp = rows.filter((r) => r.level !== 'low');
  sendSuccess(res, {
    rows,
    overall: needsHelp.some((r) => r.level === 'high') ? 'high' : needsHelp.length ? 'medium' : 'low',
    studyPlan: req.query.plan === 'true' ? await studyPlanText(needsHelp) : null,
    disclaimer: DISCLAIMER,
  });
});

// Teacher / HOD / head: which students of one course may need help.
export const coursePerformance = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.params.courseId, 'staff');
  const ids = await enrolledStudentIds(course._id);
  const [metrics, users, profiles] = await Promise.all([
    computeCourseMetrics(course, ids),
    User.find({ _id: { $in: ids } }).select('name').lean(),
    StudentProfile.find({ user: { $in: ids } }).select('user rollNumber').lean(),
  ]);
  const roll = new Map(profiles.map((p) => [String(p.user), p.rollNumber]));
  const order = { high: 0, medium: 1, low: 2 };
  const rows = users
    .map((u) => ({ student: u._id, name: u.name, rollNumber: roll.get(String(u._id)) || '', ...metrics.get(String(u._id)) }))
    .sort((a, b) => order[a.level] - order[b.level] || a.rollNumber.localeCompare(b.rollNumber));
  sendSuccess(res, { course: { _id: course._id, code: course.code, title: course.title }, rows, disclaimer: DISCLAIMER });
});

// HOD / head: how many students per course show warning signs.
export const departmentPerformance = asyncHandler(async (req, res) => {
  const filter = { status: 'active' };
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  else if (req.query.department) filter.department = req.query.department;
  if (req.query.semester) filter.semester = req.query.semester;

  const courses = await Course.find(filter).populate('semester', 'name').populate('teacher', 'name').select('code title section semester teacher').limit(60);
  const rows = [];
  for (const course of courses) {
    const ids = await enrolledStudentIds(course._id);
    if (!ids.length) continue;
    const levels = [...(await computeCourseMetrics(course, ids)).values()].map((v) => v.level);
    rows.push({
      course: { _id: course._id, code: course.code, title: course.title, section: course.section },
      semester: course.semester?.name,
      teacher: course.teacher?.name || null,
      students: ids.length,
      high: levels.filter((l) => l === 'high').length,
      medium: levels.filter((l) => l === 'medium').length,
    });
  }
  sendSuccess(res, { rows, disclaimer: DISCLAIMER });
});
