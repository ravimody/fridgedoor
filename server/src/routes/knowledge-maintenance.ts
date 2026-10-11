import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import type { KnowledgeMaintenanceService } from '../services/knowledge-maintenance.js';

export function registerKnowledgeMaintenanceRoutes(root: Hono<{ Variables: Variables }>, service: KnowledgeMaintenanceService) {
  const app = new Hono<{ Variables: Variables }>();
  const base = '/dashboard/api/v1/assistant/knowledge/proposals';
  app.use(`${base}/*`, async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.onError((error, c) => {
    const code = error instanceof ZodError ? 'VALIDATION' : /^[A-Z_]+$/.test(error.message) ? error.message : 'KNOWLEDGE_MAINTENANCE_ERROR';
    return c.json({ error: { code, message: code.toLowerCase(), requestId: c.get('requestId') } }, code === 'NOT_FOUND' ? 404 : code === 'STALE_REVISION' ? 409 : 400);
  });
  const actor = (session: unknown) => { const member = (session as { member: MemberRecord }).member; return { memberId: member.id, householdId: member.householdId }; };
  app.get(base, (c) => c.json({ data: service.list(actor(c.get('session'))) }));
  app.post(`${base}/:id/accept`, (c) => c.json({ data: service.accept(actor(c.get('session')), c.req.param('id')) }));
  app.post(`${base}/:id/dismiss`, (c) => c.json({ data: service.dismiss(actor(c.get('session')), c.req.param('id')) }));
  root.route('/', app);
}
