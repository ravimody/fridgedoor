import { z } from 'zod';
export const taskDateSchema = z.union([z.string().date(), z.string().datetime({offset:true})]);
export const listItemSchema = z.object({ id: z.string().min(1), kind: z.enum(['todo', 'grocery']), title: z.string().min(1).max(200), quantity: z.string().max(80).optional(), assigneeId: z.string().optional(), dueTime: taskDateSchema.optional(), snoozedUntil: z.string().date().optional(), completedAt: z.string().datetime({ offset: true }).nullable(), revision: z.number().int().positive(), createdAt: z.string().datetime({ offset: true }) }).strict();
export type ListItem = z.infer<typeof listItemSchema>;
export const listResponseSchema = z.object({ data: z.object({ items: z.array(listItemSchema) }).strict() }).strict();
export const chatMessageSchema = z.object({ id: z.string().min(1), role: z.enum(['user', 'assistant']), text: z.string(), createdAt: z.string().datetime({ offset: true }) }).strict();
export const chatResponseSchema = z.object({ data: z.object({ threadId: z.string(), messages: z.array(chatMessageSchema), proposals: z.array(z.object({ id: z.string(), kind: z.literal('list_item'), title: z.string(), state: z.enum(['pending', 'applied', 'expired', 'rejected']) }).strict()) }).strict() }).strict();
