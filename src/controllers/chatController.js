import AIConversation from '../models/AIConversation.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { getCourseFor } from '../services/accessService.js';
import { answerFromMaterials, callLLM, llmConfigured } from '../services/aiService.js';
import { modesFor, findMode, buildSystemPrompt, toModelMessages } from '../services/chatModes.js';
import { ROLES } from '../config/constants.js';

const MAX_STORED = 80; // messages kept per conversation
const cut = (s) => String(s).slice(0, 7990); // the database field holds 8000 characters

// The menu of the assistant for the logged-in role (students and teachers see different tools).
export const listModes = asyncHandler(async (req, res) => {
  sendSuccess(res, { modes: modesFor(req.user.role), configured: llmConfigured() });
});

// One message in a conversation. mode "course" answers only from the materials of one course the user may open.
// Every other mode is a general academic assistant, like ChatGPT, limited to educational topics.
export const chat = asyncHandler(async (req, res) => {
  const mode = findMode(req.user.role, req.body.mode || 'general');
  if (!mode) throw ApiError.badRequest('This assistant option is not available for your role');
  const message = req.body.message;

  let convo = null;
  if (req.body.conversationId) {
    convo = await AIConversation.findOne({ _id: req.body.conversationId, user: req.user._id });
    if (!convo) throw ApiError.notFound('Conversation not found');
  }

  let answer;
  let sources = [];
  let grounded;
  let course = null;
  if (mode.id === 'course') {
    const courseId = req.body.course || convo?.course;
    if (!courseId) throw ApiError.badRequest('Choose a course first');
    course = await getCourseFor(req.user, courseId, 'any'); // a student must be enrolled, a teacher must teach it
    const result = await answerFromMaterials({
      question: message,
      courseIds: [course._id],
      history: convo?.messages || [],
      includeUnreleased: req.user.role !== ROLES.STUDENT, // a student never sees topics that are not released yet
    });
    ({ answer, sources, grounded } = result);
  } else {
    if (!llmConfigured()) {
      throw new ApiError(503, 'The AI assistant is not switched on yet. The administrator must add the AI key (AI_API_KEY) on the server');
    }
    const history = toModelMessages(convo?.messages || []);
    answer = await callLLM({
      system: buildSystemPrompt(req.user.role, mode.id),
      messages: [...history, { role: 'user', content: message }],
      maxTokens: 1800,
    });
    if (!answer) throw new ApiError(502, 'The assistant returned an empty answer. Please try again');
  }

  convo = convo || new AIConversation({ user: req.user._id, mode: mode.id, course: course?._id, title: message.slice(0, 60) });
  convo.messages.push({ role: 'user', content: cut(message) });
  convo.messages.push({ role: 'assistant', content: cut(answer), sources, grounded });
  if (convo.messages.length > MAX_STORED) convo.messages = convo.messages.slice(-MAX_STORED);
  await convo.save();

  sendSuccess(res, { conversationId: convo._id, title: convo.title, mode: convo.mode, answer, grounded, sources });
});

export const removeConversation = asyncHandler(async (req, res) => {
  const done = await AIConversation.deleteOne({ _id: req.params.id, user: req.user._id });
  if (!done.deletedCount) throw ApiError.notFound('Conversation not found');
  sendSuccess(res, null, 'Conversation deleted');
});

export const renameConversation = asyncHandler(async (req, res) => {
  const convo = await AIConversation.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { title: req.body.title }, { new: true }).select('title');
  if (!convo) throw ApiError.notFound('Conversation not found');
  sendSuccess(res, convo, 'Renamed');
});
