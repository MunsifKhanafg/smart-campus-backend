import { asyncHandler } from './apiHelpers.js';
import { discardUploads } from '../middleware/upload.js';

// Wraps a controller that follows a file upload: if the request is rejected afterwards
// (wrong teacher, bad data ...), the files multer already saved are deleted so no orphan files remain.
export const uploadHandler = (fn) =>
  asyncHandler(async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      discardUploads(req);
      throw err;
    }
  });
