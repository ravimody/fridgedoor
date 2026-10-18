import { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from '../app.js';
import { errorHandler } from '../errors.js';
import type { MemberRecord } from '../auth/access.js';
import { ClarificationService } from '../services/clarifications.js';

export function registerClarificationRoutes(root: Hono<{ Variables: Variables }>, service: ClarificationService) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/dashboard/api/v1/clarifications', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  const actor = (session: unknown) => { const member = (session as { member: MemberRecord }).member; return { memberId: member.id, householdId: member.householdId }; };
  app.onError(errorHandler({ NOT_FOUND: 404, STALE_REVISION: 409 }));
  app.get('/dashboard/api/v1/clarifications', (c) => c.json({ data: service.list(actor(c.get('session'))) }));
  app.post('/dashboard/api/v1/clarifications/:id/answer', async (c) => {
    const input = z.object({ text: z.string().max(500), expectedRevision: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    return c.json({ data: service.answer(actor(c.get('session')), c.req.param('id'), input.text, input.expectedRevision) });
  });
  app.post('/dashboard/api/v1/clarifications/:id/dismiss', async (c) => {
    const input = z.object({ expectedRevision: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    return c.json({ data: service.dismiss(actor(c.get('session')), c.req.param('id'), input.expectedRevision) });
  });
  root.route('/', app);
}
