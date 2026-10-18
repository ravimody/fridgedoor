import { z } from 'zod';
export const actionResponseSchema = z.object({ data: z.object({ actionId: z.string().min(1), planId: z.string().min(1), state: z.enum(['pending', 'running', 'reconciling', 'succeeded', 'conflict', 'needs_reauth', 'failed']) }).strict() }).strict();
export type ActionResponse = z.infer<typeof actionResponseSchema>;
