import { z } from 'zod';

export const assistantResultSchema = z.object({
  reply: z.string().max(4000),
  sources: z.array(z.string().max(2000)).max(12),
  assumptions: z.array(z.string().max(300)).max(10),
  followups: z.array(z.string().max(300)).max(5),
  items: z.array(z.object({
    intent: z.enum(['direct', 'proposal']).optional(),
    kind: z.enum(['event', 'todo', 'grocery']), title: z.string().min(1).max(200),
    quantity: z.string().max(100).nullable(),
    start: z.string().datetime({ offset: true }).nullable(),
    end: z.string().datetime({ offset: true }).nullable(),
    location: z.string().max(500).nullable(), notes: z.string().max(1500).nullable(),
  }).strict()).max(40),
  knowledge: z.array(z.object({
    operation: z.enum(['set', 'delete']), key: z.string().min(1).max(80),
    value: z.string().max(500).nullable(),
  }).strict()).max(10),
}).strict();
export type AssistantResult = z.infer<typeof assistantResultSchema>;
export type AssistantReview = { calendarAction?: { state: string; kind: 'create' | 'update' | 'cancel' }; automatic?: boolean; undoneAt?: string | null; target: string; state: 'saved' | 'kept' | 'calendar' | 'dismissed' | 'draft'; planId: string | null };
export type AssistantRun = {
  reviews?: AssistantReview[];
  id: string; text: string; state: string; createdAt: string; captureId: string | null;
  result: AssistantResult | null; applied: boolean; planIds: string[];
  errorCode: string | null; feedback: string | null;
  metrics: { model: string; promptVersion: string; inputTokens: number; outputTokens: number; durationMs: number; tools: string[] } | null;
};
