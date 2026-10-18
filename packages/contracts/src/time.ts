import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });
export const timedTimeSchema = z.object({ kind: z.literal('timed'), start: instant, end: instant, timezone: z.string().min(1) }).strict();
export const deadlineTimeSchema = z.object({ kind: z.literal('deadline'), at: instant, timezone: z.string().min(1) }).strict();
export const allDayTimeSchema = z.object({ kind: z.literal('all_day'), startDate: date, endDateExclusive: date }).strict();
export const unresolvedTimeSchema = z.object({ kind: z.literal('unresolved'), dateHint: date.optional(), startHint: instant.optional(), missing: z.array(z.enum(['date', 'start', 'end', 'timezone'])).min(1) }).strict();
export const normalizedTimeSchema = z.discriminatedUnion('kind', [timedTimeSchema, allDayTimeSchema, deadlineTimeSchema, unresolvedTimeSchema]).superRefine((value, ctx) => { if (value.kind === 'timed' && Date.parse(value.end) <= Date.parse(value.start)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['end'], message: 'Timed end must be after start' }); if (value.kind === 'all_day' && value.endDateExclusive <= value.startDate) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDateExclusive'], message: 'All-day end must be exclusive and after start' }); });
export type NormalizedTime = z.infer<typeof normalizedTimeSchema>;
