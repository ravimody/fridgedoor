import { Hono } from 'hono';
import type { Variables } from '../app.js';
import { errorHandler } from '../errors.js';
import type { MemberRecord } from '../auth/access.js';
import type { RelevanceTrialService } from '../services/relevance-trial.js';
export function registerRelevanceTrialRoutes(root: Hono<{ Variables: Variables }>, service: RelevanceTrialService) {
  const app = new Hono<{ Variables: Variables }>();
  const base = '/dashboard/api/v1/relevance-trial';
  app.use('/dashboard/api/v1/relevance-trial*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.onError(errorHandler({ NOT_FOUND: 404, STALE_REVISION: 409 }));
  const actor = (session: unknown) => { const member = (session as { member: MemberRecord }).member; return { memberId: member.id, householdId: member.householdId }; };
  app.get(base, c => c.json({ data: service.list(actor(c.get('session'))) }));
  app.post(`${base}/next`, c => c.json({ data: service.next(actor(c.get('session'))) }));
  app.get(`${base}/summary`, c => c.json({ data: service.summary(actor(c.get('session'))) }));
  app.post(`${base}/summary`, async c => c.json({ data: await service.compact(actor(c.get('session'))) }));
  app.get(`${base}/learning`, c => c.json({data:service.learning(actor(c.get('session')))}));
  app.post(`${base}/learning`, async c => c.json({data:service.configureLearning(actor(c.get('session')),await c.req.json())}));
  app.post(`${base}/learning/forget`, async c => c.json({data:service.forgetLearning(actor(c.get('session')),await c.req.json())}));
  app.post(`${base}/:id`, async c => c.json({ data: service.rate(actor(c.get('session')), c.req.param('id'), await c.req.json()) }));
  app.delete(base, c => c.json({ data: service.clear(actor(c.get('session'))) }));
  root.route('/', app);
}
