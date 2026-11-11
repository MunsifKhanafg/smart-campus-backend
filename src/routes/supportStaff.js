import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import { createStaffSchema, updateStaffSchema, listStaffQuery } from '../validators/supportStaffSchemas.js';
import { listStaff, getStaff, createStaff, updateStaff, deleteStaff, photoUpload, putPhoto, removePhoto, getPhoto } from '../controllers/supportStaffController.js';

const { UNIVERSITY_HEAD, HOD } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');

// Class IV (support) staff of the departments. Only the principal and the HODs: it holds phone numbers and CNICs.
// Mounted at /api/support-staff. An HOD reaches only their own department (checked again inside every controller function).
export const supportStaffRouter = Router();
supportStaffRouter.use(protect, authorize(UNIVERSITY_HEAD, HOD));
supportStaffRouter.get('/', validate(listStaffQuery, 'query'), listStaff);
supportStaffRouter.post('/', validate(createStaffSchema), createStaff);
supportStaffRouter.get('/photo/:id', idParam, getPhoto); // <Avatar photoBase="/support-staff/photo" /> downloads from here
supportStaffRouter.get('/:id', idParam, getStaff);
supportStaffRouter.put('/:id', idParam, validate(updateStaffSchema), updateStaff);
supportStaffRouter.delete('/:id', idParam, deleteStaff);
supportStaffRouter.put('/:id/photo', idParam, photoUpload, putPhoto);
supportStaffRouter.delete('/:id/photo', idParam, removePhoto);
