import { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from '../app.js';
import { errorHandler } from '../errors.js';
import type { MemberRecord } from '../auth/access.js';
import { DAILY_AI_CONSENT, DailyOverviewService } from '../services/daily-overview.js';
import { JobQueue } from '../jobs/queue.js';

export function registerDailyOverviewRoutes(root: Hono<{ Variables: Variables }>, service: DailyOverviewService, queue: JobQueue) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/dashboard/api/v1/daily-ai-settings', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.use('/dashboard/api/v1/daily-overview*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  const actor = (session: unknown) => { const member = (session as { member: MemberRecord }).member; return { memberId: member.id, householdId: member.householdId }; };
  app.onError(errorHandler({ NOT_FOUND: 404, STALE_REVISION: 409 }));
  app.get('/dashboard/api/v1/daily-ai-settings', (c) => c.json({ data: { ...service.settings(actor(c.get('session'))), disclosureVersion: DAILY_AI_CONSENT } }));
  app.post('/dashboard/api/v1/daily-ai-settings', async (c) => {
    const input = z.object({ enabled: z.boolean(), expectedRevision: z.number().int().nonnegative(), consentVersion: z.string().optional() }).strict().parse(await c.req.json());
    const settingsInput = { enabled: input.enabled, expectedRevision: input.expectedRevision, ...(input.consentVersion === undefined ? {} : { consentVersion: input.consentVersion }) };
    return c.json({ data: { ...service.setSettings(actor(c.get('session')), settingsInput), disclosureVersion: DAILY_AI_CONSENT } });
  });
  app.get('/dashboard/api/v1/daily-overview', (c) => c.json({ data: service.readOrRefresh(actor(c.get('session')), queue) }));
  app.post('/dashboard/api/v1/daily-overview/refresh', async (c) => {
    const input = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    return c.json({ data: service.requestRefresh(actor(c.get('session')), queue, input.expectedRevision) }, 202);
  });
  app.post('/dashboard/api/v1/daily-overview/dismiss', async c => {
    const input=z.object({refs:z.array(z.string().min(1).max(160)).min(1).max(5),expectedRevision:z.number().int().nonnegative()}).strict().parse(await c.req.json());
    return c.json({data:service.dismiss(actor(c.get('session')),input.refs,input.expectedRevision)});
  });
  app.post('/dashboard/api/v1/daily-overview/restore', async c => {
    const input=z.object({undoToken:z.string().min(1).max(6000)}).strict().parse(await c.req.json());
    return c.json({data:service.restore(actor(c.get('session')),input.undoToken)});
  });
  root.route('/', app);
}
