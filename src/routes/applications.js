import { Router } from 'express';
import { z } from 'zod';
import { protect, authorize } from '../middleware/auth.js';
import { privateUpload, discardUploads } from '../middleware/upload.js';
import { applyLimiter, applyTrackLimiter } from '../middleware/rateLimit.js';
import { validate, objectId } from '../validators/validate.js';
import { ROLES } from '../config/constants.js';
import { applySchema, trackSchema, resubmitSchema, enrollApplicantSchema, listApplicationsQuery, reviewApplicationSchema, meritListQuery } from '../validators/applicationSchemas.js';
import {
  getPortal,
  submitApplication,
  trackApplication,
  resubmit,
  publicMeritList,
  listApplications,
  getApplication,
  reviewApplication,
  enrollApplicant,
  downloadApplicationFile,
} from '../controllers/applicationController.js';
import { meritStatus, publishMerit, resetMerit } from '../controllers/meritController.js';

const { UNIVERSITY_HEAD, HOD } = ROLES;
const idParam = validate(z.object({ id: objectId }), 'params');
const fileParam = validate(z.object({ id: objectId, storedName: z.string().regex(/^[a-f0-9]{32}\.[a-z0-9]{3,4}$/) }), 'params');

// The apply form is multipart, so multer saves the files BEFORE the form fields can be validated.
// If validation then fails, those files must not stay on the disk (this endpoint is public, so it is a spam target).
const validateOrDiscard = (schema) => {
  const check = validate(schema);
  return (req, res, next) => {
    try {
      check(req, res, (err) => {
        if (err) discardUploads(req);
        next(err);
      });
    } catch (err) {
      discardUploads(req);
      next(err);
    }
  };
};

// ---------- Public (no login) ----------
// Mounted at /api/public
export const publicAdmissionRouter = Router();
publicAdmissionRouter.get('/admissions/portal', getPortal);
publicAdmissionRouter.post(
  '/admissions/apply',
  applyLimiter,
  ...privateUpload('applications', { maxMB: 5, maxFiles: 10 }),
  validateOrDiscard(applySchema),
  submitApplication
);
publicAdmissionRouter.post('/admissions/track', applyTrackLimiter, validate(trackSchema), trackApplication);
// An applicant who was asked for more documents uploads them here (multipart; the controller validates and discards files on error).
publicAdmissionRouter.post('/admissions/resubmit', applyTrackLimiter, ...privateUpload('applications', { maxMB: 5, maxFiles: 10 }), resubmit);
publicAdmissionRouter.get('/merit-list', applyTrackLimiter, validate(meritListQuery, 'query'), publicMeritList);

// ---------- Staff ----------
// Mounted at /api/applications. The University Head sees every department, an HOD only their own.
export const applicationRouter = Router();
applicationRouter.use(protect, authorize(UNIVERSITY_HEAD, HOD));
applicationRouter.get('/', validate(listApplicationsQuery, 'query'), listApplications);
// Merit list and interview calls. Only the University Head runs them. These routes must stay above '/:id'.
applicationRouter.get('/merit/status', authorize(UNIVERSITY_HEAD), meritStatus);
applicationRouter.post('/merit/publish', authorize(UNIVERSITY_HEAD), publishMerit);
applicationRouter.post('/merit/reset', authorize(UNIVERSITY_HEAD), resetMerit);
applicationRouter.get('/:id', idParam, getApplication);
applicationRouter.post('/:id/review', idParam, validate(reviewApplicationSchema), reviewApplication);
// Only the HOD turns an accepted applicant into a student of their own department.
applicationRouter.post('/:id/enroll', authorize(HOD), idParam, validate(enrollApplicantSchema), enrollApplicant);
applicationRouter.get('/:id/files/:storedName', fileParam, downloadApplicationFile);
