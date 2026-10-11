import { z } from 'zod';
import { normalizedTimeSchema } from './time.js';

export const planFactsSchema = z.object({
  title: z.string().min(1).max(200), category: z.string().min(1).max(80), participants: z.array(z.string().min(1).max(80)).max(10),
  time: normalizedTimeSchema.optional(), location: z.string().max(500).optional(), notes: z.string().max(2000).optional(),
  preparationTasks: z.array(z.string().max(200)).max(20), unresolvedFields: z.array(z.string().max(80)).max(10),
}).strict();
export type PlanFacts = z.infer<typeof planFactsSchema>;

export const planSummarySchema = z.object({
  savedInPlanner: z.boolean().optional(),
  calendarAction: z.object({ actionId: z.string(), state: z.string(), kind: z.enum(['create', 'update', 'cancel']).optional() }).nullable().optional(),
  id: z.string().min(1), revision: z.number().int().positive(), visibility: z.enum(['shared', 'private']), status: z.enum(['needs_details', 'proposed', 'dismissed', 'accepted', 'archived']),
  facts: planFactsSchema, changeKind: z.enum(['new', 'update', 'cancel']).nullable(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  sourceSummary: z.object({ kind: z.string(), count: z.number().int().nonnegative(), available: z.boolean() }).strict(), possibleDuplicate: z.boolean(), pendingFacts: planFactsSchema.optional(),
}).strict();
export type PlanSummary = z.infer<typeof planSummarySchema>;
export const plansResponseSchema = z.object({ data: z.object({ plans: z.array(planSummarySchema) }).strict() }).strict();
export const planResponseSchema = z.object({ data: planSummarySchema }).strict();
export const planFactsPatchSchema = z.object({ expectedRevision: z.number().int().positive(), facts: planFactsSchema }).strict();
export const sharePlanSchema = z.object({ expectedRevision: z.number().int().positive(), reviewedFacts: planFactsSchema }).strict();
export const dismissPlanSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const historyEntrySchema = z.object({ id: z.string().min(1), type: z.string().min(1), actorLabel: z.string().min(1), safePayload: z.record(z.unknown()), createdAt: z.string().datetime({ offset: true }) }).strict();
export const historyResponseSchema = z.object({ data: z.object({ entries: z.array(historyEntrySchema) }).strict() }).strict();
export const evidenceResponseSchema = z.object({ data: z.object({ sourceVersionId: z.string().min(1), availability: z.enum(['available', 'expired', 'deleted', 'incomplete']), kind: z.string(), text: z.string().optional(), sender: z.string().optional(), labels: z.array(z.string()) }).strict() }).strict();
export type PlanFactsPatch = z.infer<typeof planFactsPatchSchema>;
