import { asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { meritPreview, publishMeritList, resetMeritList } from '../services/meritService.js';

// University Head only (see routes/applications.js).
export const meritStatus = asyncHandler(async (_req, res) => sendSuccess(res, await meritPreview()));

export const publishMerit = asyncHandler(async (req, res) => {
  const result = await publishMeritList();
  logAudit(req, 'merit.publish', 'UniversitySettings', undefined, { called: result.called, emailed: result.emailed });
  sendSuccess(res, result, 'Merit list published. The selected applicants were called for an interview');
});

export const resetMerit = asyncHandler(async (req, res) => {
  const result = await resetMeritList();
  logAudit(req, 'merit.reset', 'UniversitySettings', undefined, result);
  sendSuccess(res, result, 'Merit list withdrawn');
});
