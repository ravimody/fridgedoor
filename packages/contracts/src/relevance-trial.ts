import { z } from 'zod';
import { planFactsSchema } from './plans.js';
export const trialVoteSchema = z.enum(['useful', 'not_useful', 'skip']);
export const trialRatingSchema = z.object({ value: trialVoteSchema, reason: z.string().trim().max(500).default(''), expectedRevision: z.number().int().positive() }).strict();
export const trialItemSchema = z.object({ id: z.string(), facts: planFactsSchema, source: z.object({ sender: z.string().nullable(), excerpt: z.string().nullable(), available: z.boolean() }).optional(), observedAt: z.string(), value: trialVoteSchema.nullable(), reason: z.string(), revision: z.number().int().positive() });
export const trialResponseSchema = z.object({ data: z.object({ items: z.array(trialItemSchema), expiresAt: z.string().nullable() }) });
export type TrialItem = z.infer<typeof trialItemSchema>;
export const trialSummarySchema = z.object({
  overview: z.string().max(700),
  preferences: z.array(z.object({ direction: z.enum(['prefer', 'avoid', 'uncertain']), pattern: z.string().max(400), evidenceIds: z.array(z.string()).min(1).max(100) }).strict()).max(8),
}).strict();
export type TrialSummary = z.infer<typeof trialSummarySchema>;
