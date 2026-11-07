import { z } from 'zod';
import { objectId } from './validate.js';

export const generateMeritSchema = z.object({
  department: objectId.optional(), // the University Head chooses; an HOD always uses their own department
  program: z.union([objectId, z.literal('')]).optional(), // empty = all programmes of the department together
  seats: z.number().int().min(0).max(5000),
});

export const publishMeritSchema = z.object({
  // Also mark the selected applicants as "accepted" in the same step (and tell them why in their history).
  acceptSelected: z.boolean().optional(),
});

export const publicMeritQuery = z.object({
  department: objectId.optional(),
});
