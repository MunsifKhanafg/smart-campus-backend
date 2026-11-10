import CourseTopic from '../models/CourseTopic.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { uploadHandler } from '../utils/uploadHandler.js';
import { getCourseFor } from '../services/accessService.js';
import { assertTeachingDate } from '../services/teachingCalendarService.js';
import { indexMaterialFile, removeChunksForFile, removeChunksForTopic, syncTopicRelease } from '../services/ragService.js';
import { toFileDocs, removeStored, sendStored } from '../middleware/upload.js';
import { ROLES } from '../config/constants.js';

const publicFile = (m) => ({ originalName: m.originalName, storedName: m.storedName, mimeType: m.mimeType, size: m.size, indexed: m.indexed });

// What a student may see:
//   upcoming  -> only the title and the date (no description, no files)
//   available -> everything
//   closed    -> the teacher set an "available until" date that has passed
export const topicState = (t, now = new Date()) => {
  if (t.scheduledDate > now) return 'upcoming';
  if (t.availableUntil && t.availableUntil < now) return 'closed';
  return 'available';
};

const shapeForStudent = (t, now) => {
  const state = topicState(t, now);
  const base = { _id: t._id, course: t.course, title: t.title, scheduledDate: t.scheduledDate, state };
  if (state !== 'available') return base;
  return {
    ...base,
    description: t.description,
    materials: t.materials.map(publicFile),
    relatedAssignment: t.relatedAssignment,
    availableUntil: t.availableUntil,
  };
};

const shapeForStaff = (t, now) => ({ ...t.toObject(), materials: t.materials.map(publicFile), state: topicState(t, now) });

const loadTopic = async (id) => {
  const topic = await CourseTopic.findById(id);
  if (!topic) throw ApiError.notFound('Topic not found');
  return topic;
};

export const listTopics = asyncHandler(async (req, res) => {
  await getCourseFor(req.user, req.query.course, 'any');
  const now = new Date();
  const topics = await CourseTopic.find({ course: req.query.course }).sort({ scheduledDate: 1 });
  const isStudent = req.user.role === ROLES.STUDENT;
  sendSuccess(res, topics.map((t) => (isStudent ? shapeForStudent(t, now) : shapeForStaff(t, now))));
});

export const createTopic = asyncHandler(async (req, res) => {
  const course = await getCourseFor(req.user, req.body.course, 'write');
  // A date chosen by hand must be a real teaching day: inside the semester, not a holiday, exam, vacation or weekly holiday.
  await assertTeachingDate(course, req.body.scheduledDate);
  if (req.body.availableUntil && req.body.availableUntil <= req.body.scheduledDate) {
    throw ApiError.badRequest('"Available until" must be after the scheduled date');
  }
  const topic = await CourseTopic.create({
    ...req.body,
    course: course._id,
    department: course.department,
    semester: course.semester._id,
    createdBy: req.user._id,
  });
  logAudit(req, 'topic.create', 'CourseTopic', topic._id, { course: course.code, title: topic.title });
  sendSuccess(res, shapeForStaff(topic, new Date()), 'Topic created', 201);
});

export const updateTopic = asyncHandler(async (req, res) => {
  const topic = await loadTopic(req.params.id);
  const course = await getCourseFor(req.user, topic.course, 'write');
  // Changing the date by hand: it must be a teaching day, and the topic is then "pinned" (the scheduler never moves it again).
  if (req.body.scheduledDate && +new Date(req.body.scheduledDate) !== +topic.scheduledDate) {
    await assertTeachingDate(course, req.body.scheduledDate);
    topic.autoScheduled = false;
  }
  topic.set(req.body);
  if (topic.availableUntil && topic.availableUntil <= topic.scheduledDate) {
    throw ApiError.badRequest('"Available until" must be after the scheduled date');
  }
  await topic.save();
  await syncTopicRelease(topic); // the AI assistant must follow the new release date
  logAudit(req, 'topic.update', 'CourseTopic', topic._id, { fields: Object.keys(req.body) });
  sendSuccess(res, shapeForStaff(topic, new Date()), 'Topic updated');
});

export const deleteTopic = asyncHandler(async (req, res) => {
  const topic = await loadTopic(req.params.id);
  await getCourseFor(req.user, topic.course, 'write');
  removeStored('materials', topic.materials);
  await removeChunksForTopic(topic._id);
  await topic.deleteOne();
  logAudit(req, 'topic.delete', 'CourseTopic', topic._id);
  sendSuccess(res, null, 'Topic deleted');
});

// Teacher uploads one or more files (PDF, DOCX, PPTX, TXT, images). Text files are indexed for the AI assistant.
export const uploadMaterials = uploadHandler(async (req, res) => {
  const topic = await loadTopic(req.params.id);
  await getCourseFor(req.user, topic.course, 'write');
  if (!req.files?.length) throw ApiError.badRequest('Please choose at least one file');

  const docs = toFileDocs(req.files);
  for (const doc of docs) doc.indexed = await indexMaterialFile({ topic, file: doc });
  topic.materials.push(...docs);
  await topic.save();

  logAudit(req, 'topic.materials_add', 'CourseTopic', topic._id, { files: docs.length });
  sendSuccess(res, shapeForStaff(topic, new Date()), 'Materials uploaded', 201);
});

export const deleteMaterial = asyncHandler(async (req, res) => {
  const topic = await loadTopic(req.params.id);
  await getCourseFor(req.user, topic.course, 'write');
  const file = topic.materials.find((m) => m.storedName === req.params.storedName);
  if (!file) throw ApiError.notFound('File not found');
  removeStored('materials', [file]);
  await removeChunksForFile(file.storedName);
  topic.materials = topic.materials.filter((m) => m.storedName !== file.storedName);
  await topic.save();
  sendSuccess(res, shapeForStaff(topic, new Date()), 'File removed');
});

export const downloadMaterial = asyncHandler(async (req, res) => {
  const topic = await loadTopic(req.params.id);
  await getCourseFor(req.user, topic.course, 'any');
  if (req.user.role === ROLES.STUDENT && topicState(topic) !== 'available') {
    throw ApiError.forbidden('This topic is not available to you right now');
  }
  const file = topic.materials.find((m) => m.storedName === req.params.storedName);
  if (!file) throw ApiError.notFound('File not found');
  sendStored(res, 'materials', file);
});
