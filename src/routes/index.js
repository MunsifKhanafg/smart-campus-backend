import { Router } from 'express';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { uploadLogo } from '../middleware/upload.js';
import { ROLES } from '../config/constants.js';
import { z } from 'zod';
import {
  loginSchema,
  changePasswordSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  departmentStatusSchema,
  assignHodSchema,
  createUserSchema,
  listUsersQuery,
  userActiveSchema,
  updateSettingsSchema,
  updateAccountSchema,
  resetPasswordSchema,
  updateUserSchema,
} from '../validators/schemas.js';
import { login, me, changePassword, updateAccount } from '../controllers/authController.js';
import { getPublicSettings, getSettings, updateSettings, uploadLogoFile } from '../controllers/settingsController.js';
import {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  setDepartmentStatus,
  assignHod,
} from '../controllers/departmentController.js';
import { createUser, listUsers, setUserActive, deleteUser, teacherProfile, resetPassword, changeUserEmail, updateUser } from '../controllers/userController.js';
import { loginLimiter } from '../middleware/rateLimit.js';

const { UNIVERSITY_HEAD, HOD } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');

// ---------- Auth ----------
export const authRouter = Router();
authRouter.post('/login', loginLimiter, validate(loginSchema), login);
authRouter.get('/me', protect, me);
authRouter.post('/change-password', protect, validate(changePasswordSchema), changePassword);
authRouter.patch('/account', protect, validate(updateAccountSchema), updateAccount);

// ---------- Settings ----------
export const settingsRouter = Router();
settingsRouter.get('/public', getPublicSettings); // no login needed (login page, contact page)
settingsRouter.use(protect, authorize(UNIVERSITY_HEAD));
settingsRouter.get('/', getSettings);
settingsRouter.put('/', validate(updateSettingsSchema), updateSettings);
settingsRouter.post('/logo', uploadLogo, uploadLogoFile);

// ---------- Departments ----------
export const departmentRouter = Router();
departmentRouter.use(protect);
departmentRouter.get('/', listDepartments);
departmentRouter.post('/', authorize(UNIVERSITY_HEAD), validate(createDepartmentSchema), createDepartment);
departmentRouter.get('/:id', idParam, getDepartment);
departmentRouter.put('/:id', authorize(UNIVERSITY_HEAD, HOD), idParam, validate(updateDepartmentSchema), updateDepartment);
departmentRouter.patch('/:id/status', authorize(UNIVERSITY_HEAD), idParam, validate(departmentStatusSchema), setDepartmentStatus);
departmentRouter.post('/:id/hod', authorize(UNIVERSITY_HEAD), idParam, validate(assignHodSchema), assignHod);

// ---------- Users ----------
export const userRouter = Router();
userRouter.use(protect, authorize(UNIVERSITY_HEAD, HOD));
userRouter.get('/', validate(listUsersQuery, 'query'), listUsers);
userRouter.post('/', validate(createUserSchema), createUser);
userRouter.patch('/:id/active', idParam, validate(userActiveSchema), setUserActive);
// Fix a typing mistake in a teacher's name, email, phone or qualification (HOD: own department).
userRouter.put('/:id', idParam, validate(updateUserSchema), updateUser);
userRouter.delete('/:id', idParam, deleteUser);
userRouter.get('/:id/profile', idParam, teacherProfile);
// Forgotten password: the principal (anybody) or an HOD (teachers of their own department) sets a temporary password.
userRouter.post('/:id/reset-password', idParam, validate(resetPasswordSchema), resetPassword);
userRouter.patch('/:id/email', authorize(UNIVERSITY_HEAD), idParam, validate(z.object({ email: z.string().trim().toLowerCase().email().max(120) })), changeUserEmail);
