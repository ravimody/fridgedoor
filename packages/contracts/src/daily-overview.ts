import { z } from 'zod';

const ref = z.string().min(1).max(160);

export const dailyOverviewItemSchema = z.object({
  refs: z.array(ref).min(1).max(5),
  category: z.enum(['today', 'prepare', 'deadline', 'change', 'decision']),
  headline: z.string().min(1).max(100),
  detail: z.string().max(400),
  priority: z.enum(['important', 'routine']),
}).strict();

export const dailyOverviewQuestionSchema = z.object({
  refs: z.array(ref).min(1).max(5),
  text: z.string().min(1).max(240),
  reason: z.string().max(300),
}).strict();

export const dailyOverviewSchema = z.object({
  summary: z.string().max(600),
  // Required commitments cannot be squeezed out by the eight-item editorial target.
  items: z.array(dailyOverviewItemSchema).max(150),
  questions: z.array(dailyOverviewQuestionSchema).max(2),
  omittedRefs: z.array(z.object({ ref, reason: z.enum(['duplicate', 'resolved', 'optional', 'stale', 'irrelevant']) }).strict()).max(150),
}).strict();

export type DailyOverview = z.infer<typeof dailyOverviewSchema>;
