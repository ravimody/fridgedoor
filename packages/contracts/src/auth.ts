import { z } from 'zod';

export const memberSchema = z.object({
  id: z.string().min(1), householdId: z.string().min(1), displayName: z.string().min(1), timezone: z.string().min(1),
}).strict();
export const sessionResponseSchema = z.object({ data: z.object({ member: memberSchema, csrfToken: z.string().min(32) }).strict() }).strict();
export const householdPersonSchema = z.object({ id: z.string(), displayName: z.string() }).strict();
export const meResponseSchema = z.object({ data: z.object({ member: memberSchema, household: z.array(householdPersonSchema).optional(), householdName: z.string().optional(), email: z.string().optional(), role: z.enum(['owner', 'member']).optional(), canManage: z.boolean().optional() }).strict() }).strict();
export const errorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }).strict() }).strict();
export type Member = z.infer<typeof memberSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
