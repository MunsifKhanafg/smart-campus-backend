import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { privateUpload } from '../middleware/upload.js';
import { aiLimiter } from '../middleware/rateLimit.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import { createComplaintSchema, respondSchema, complaintsQuery, createAnnouncementSchema } from '../validators/phase7Schemas.js';
import { createComplaint, myComplaints, listComplaints, respond, downloadAttachment } from '../controllers/complaintController.js';
import { listMine, listManaged, createAnnouncement, deleteAnnouncement } from '../controllers/announcementController.js';
import { contactInfo } from '../controllers/publicController.js';
import { overview } from '../controllers/reportController.js';
import { ask, listConversations, getConversation, myPerformance, coursePerformance, departmentPerformance } from '../controllers/assistantController.js';
import { listModes, chat, removeConversation, renameConversation } from '../controllers/chatController.js';

const { UNIVERSITY_HEAD, HOD, FINANCE_OFFICER, LIBRARY_CONTROLLER, TEACHER, STUDENT } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const courseParam = validate(z.object({ courseId: objectId }), 'params');
const fileParam = validate(z.object({ id: objectId, storedName: z.string().regex(/^[a-f0-9]{32}\.[a-z0-9]{3,4}$/) }), 'params');

// ---------- Complaints and requests ----------
export const complaintRouter = Router();
complaintRouter.use(protect);
complaintRouter.post('/', authorize(STUDENT), ...privateUpload('complaints', { maxMB: 8, maxFiles: 3 }), validate(createComplaintSchema), createComplaint);
complaintRouter.get('/mine', authorize(STUDENT), myComplaints);
complaintRouter.get('/', authorize(HOD, UNIVERSITY_HEAD, FINANCE_OFFICER), validate(complaintsQuery, 'query'), listComplaints);
complaintRouter.post('/:id/respond', authorize(HOD, UNIVERSITY_HEAD, FINANCE_OFFICER), idParam, validate(respondSchema), respond);
complaintRouter.get('/:id/files/:storedName', authorize(STUDENT, HOD, UNIVERSITY_HEAD, FINANCE_OFFICER), fileParam, downloadAttachment);

// ---------- Announcements ----------
export const announcementRouter = Router();
announcementRouter.use(protect);
announcementRouter.get('/', listMine);
announcementRouter.get('/manage', authorize(UNIVERSITY_HEAD, HOD), listManaged);
announcementRouter.post('/', authorize(UNIVERSITY_HEAD, HOD), validate(createAnnouncementSchema), createAnnouncement);
announcementRouter.delete('/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, deleteAnnouncement);

// ---------- Public contact page (no login) ----------
export const publicContactRouter = Router();
publicContactRouter.get('/contact', contactInfo);

// ---------- Reports ----------
export const reportRouter = Router();
reportRouter.use(protect, authorize(UNIVERSITY_HEAD, HOD));
reportRouter.get('/overview', overview);

// ---------- AI assistant and performance support ----------
const askSchema = z.object({ course: objectId, question: z.string().trim().min(3).max(1000), conversationId: objectId.optional() });
const deptPerfQuery = z.object({ department: objectId.optional(), semester: objectId.optional() });
const convoQuery = z.object({ course: objectId.optional() });
const planQuery = z.object({ plan: z.enum(['true', 'false']).optional() });
const chatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: objectId.optional(),
  mode: z.string().trim().max(20).optional(),
  course: objectId.optional(),
});
const renameSchema = z.object({ title: z.string().trim().min(1).max(80) });

export const aiRouter = Router();
aiRouter.use(protect);
aiRouter.post('/ask', authorize(HOD, UNIVERSITY_HEAD), aiLimiter, validate(askSchema), ask);
// Students and the library controller reach ONLY the library assistant (modesFor() in services/chatModes.js gives them that one option, and
// the chat controller loads a student's own library record only). Their conversations are their own: every query filters by the logged-in user.
const CHAT_ROLES = [HOD, UNIVERSITY_HEAD, FINANCE_OFFICER, STUDENT, LIBRARY_CONTROLLER];
aiRouter.get('/conversations', authorize(...CHAT_ROLES), validate(convoQuery, 'query'), listConversations);
aiRouter.get('/conversations/:id', authorize(...CHAT_ROLES), idParam, getConversation);
// General AI assistant (ChatGPT-like): menu of tools, one message per request, rename and delete chats.
aiRouter.get('/modes', authorize(...CHAT_ROLES), listModes);
aiRouter.post('/chat', authorize(...CHAT_ROLES), aiLimiter, validate(chatSchema), chat);
aiRouter.patch('/conversations/:id', authorize(...CHAT_ROLES), idParam, validate(renameSchema), renameConversation);
aiRouter.delete('/conversations/:id', authorize(...CHAT_ROLES), idParam, removeConversation);
aiRouter.get('/performance/me', authorize(STUDENT), aiLimiter, validate(planQuery, 'query'), myPerformance);
aiRouter.get('/performance/department', authorize(HOD, UNIVERSITY_HEAD), validate(deptPerfQuery, 'query'), departmentPerformance);
aiRouter.get('/performance/course/:courseId', authorize(TEACHER, HOD, UNIVERSITY_HEAD), courseParam, coursePerformance);
