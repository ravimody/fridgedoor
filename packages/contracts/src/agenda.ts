import { z } from 'zod';
import { normalizedTimeSchema } from './time.js';
export const agendaItemSchema = z.object({ planId: z.string().optional(), id: z.string().min(1), title: z.string().min(1).max(200), time: normalizedTimeSchema, location: z.string().max(500).optional(), status: z.enum(['confirmed', 'tentative']), visibility: z.enum(['shared', 'owner']), origin: z.enum(['household calendar', 'your private calendar']) }).strict();
export const agendaResponseSchema = z.object({ data: z.object({ items: z.array(agendaItemSchema) }).strict() }).strict();
