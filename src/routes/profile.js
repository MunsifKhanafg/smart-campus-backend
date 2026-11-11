import { Router } from 'express';
import { z } from 'zod';
import { protect } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { updateProfileSchema } from '../validators/profileSchemas.js';
import { getProfile, updateProfile, photoUpload, uploadPhoto, removePhoto, getPhoto } from '../controllers/profileController.js';

const idParam = validate(z.object({ id: objectId }), 'params');

// Who may do what is decided inside the controller (the person, the principal, the HOD of the department).
export const profileRouter = Router();
profileRouter.use(protect);
profileRouter.get('/:id', idParam, getProfile);
profileRouter.put('/:id', idParam, validate(updateProfileSchema), updateProfile);
profileRouter.put('/:id/photo', idParam, photoUpload, uploadPhoto);
profileRouter.delete('/:id/photo', idParam, removePhoto);

export const photoRouter = Router();
photoRouter.use(protect);
photoRouter.get('/:id', idParam, getPhoto);
