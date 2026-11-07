import { z } from 'zod';
import { objectId } from './validate.js';
import { ASSIGNMENT_TYPES, ATTENDANCE_STATUS, QUIZ_TYPES } from '../config/constants.js';

const date = z.coerce.date();

// ---------- Topics ----------
export const listTopicsQuery = z.object({ course: objectId });

export const createTopicSchema = z.object({
  course: objectId,
  title: z.string().trim().min(2).max(200),
  description: z.string().max(5000).optional(),
  scheduledDate: date,
  availableUntil: date.nullable().optional(),
  relatedAssignment: objectId.nullable().optional(),
});
export const updateTopicSchema = createTopicSchema.omit({ course: true }).partial();

// ---------- Assignments ----------
export const listAssignmentsQuery = z.object({ course: objectId });

const assignmentBase = z.object({
  course: objectId,
  type: z.enum(ASSIGNMENT_TYPES).default('assignment'),
  title: z.string().trim().min(2).max(200),
  description: z.string().max(5000).optional(),
  instructions: z.string().max(5000).optional(),
  releaseDate: date,
  deadline: date,
  maxMarks: z.coerce.number().min(1).max(1000),
  allowLateSubmission: z.boolean().optional(),
});
export const createAssignmentSchema = assignmentBase.refine((v) => v.deadline > v.releaseDate, {
  message: 'Deadline must be after the release date',
  path: ['deadline'],
});
export const updateAssignmentSchema = assignmentBase.omit({ course: true }).partial();

export const submitAssignmentSchema = z.object({ text: z.string().max(10000).optional() });
export const gradeSchema = z.object({
  marks: z.coerce.number().min(0),
  feedback: z.string().max(3000).optional(),
});

// ---------- Attendance ----------
export const sheetQuery = z.object({ date: date.optional() });
export const saveAttendanceSchema = z.object({
  date,
  records: z
    .array(z.object({ student: objectId, status: z.enum(Object.values(ATTENDANCE_STATUS)) }))
    .min(1)
    .max(500),
});
export const myAttendanceQuery = z.object({ course: objectId.optional() });
export const deptAttendanceQuery = z.object({ department: objectId.optional(), semester: objectId.optional() });

// ---------- Quizzes ----------
export const listQuizzesQuery = z.object({ course: objectId });

const questionSchema = z.object({
  text: z.string().trim().min(2).max(1000),
  options: z.array(z.string().trim().min(1).max(300)).min(2).max(6),
  correctIndex: z.number().int().min(0),
  marks: z.number().min(0.5).max(100).default(1),
});

const quizBase = z.object({
  course: objectId,
  title: z.string().trim().min(2).max(200),
  type: z.enum(QUIZ_TYPES),
  durationMinutes: z.number().int().min(1).max(240),
  startTime: date.optional(),
  endTime: date.optional(),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  questions: z.array(questionSchema).min(1).max(100),
});

const quizChecks = (v, ctx) => {
  v.questions?.forEach((q, i) => {
    if (q.correctIndex >= q.options.length) {
      ctx.addIssue({ code: 'custom', message: 'Correct answer must be one of the options', path: ['questions', i, 'correctIndex'] });
    }
  });
};

export const createQuizSchema = quizBase.superRefine((v, ctx) => {
  quizChecks(v, ctx);
  if (v.type === 'scheduled') {
    if (!v.startTime || !v.endTime) ctx.addIssue({ code: 'custom', message: 'Scheduled quizzes need a start and end time', path: ['startTime'] });
    else if (v.endTime <= v.startTime) ctx.addIssue({ code: 'custom', message: 'End time must be after the start time', path: ['endTime'] });
  }
});
export const updateQuizSchema = quizBase.omit({ course: true, type: true }).partial().superRefine(quizChecks);

export const answersSchema = z.object({
  answers: z.array(z.object({ question: objectId, selected: z.number().int().min(0) })).max(100),
});
