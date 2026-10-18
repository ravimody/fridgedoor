import { Hono } from 'hono';
import type { Variables } from '../app.js';
import { errorHandler } from '../errors.js';
import type { MemberRecord } from '../auth/access.js';
import type { KnowledgeMaintenanceService } from '../services/knowledge-maintenance.js';

export function registerKnowledgeMaintenanceRoutes(root: Hono<{ Variables: Variables }>, service: KnowledgeMaintenanceService) {
  const app = new Hono<{ Variables: Variables }>();
  const base = '/dashboard/api/v1/assistant/knowledge/proposals';
  app.use(`${base}/*`, async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.onError(errorHandler({ NOT_FOUND: 404, STALE_REVISION: 409 }));
  const actor = (session: unknown) => { const member = (session as { member: MemberRecord }).member; return { memberId: member.id, householdId: member.householdId }; };
  app.get(base, (c) => c.json({ data: service.list(actor(c.get('session'))) }));
  app.post(`${base}/:id/accept`, (c) => c.json({ data: service.accept(actor(c.get('session')), c.req.param('id')) }));
  app.post(`${base}/:id/dismiss`, (c) => c.json({ data: service.dismiss(actor(c.get('session')), c.req.param('id')) }));
  root.route('/', app);
}
