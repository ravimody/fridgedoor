import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import type { Variables } from '../app.js';
import type { BackgroundAiService } from '../services/background-ai.js';
import type { MemberRecord } from '../auth/access.js';
export function registerBackgroundAiRoutes(root: Hono<{ Variables: Variables }>, service: BackgroundAiService) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/dashboard/api/v1/background-ai', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  const actor = (session: unknown) => { const member = (session as { member: MemberRecord }).member; return { memberId: member.id, householdId: member.householdId }; };
  app.onError((error, c) => {
    const code = error instanceof ZodError ? 'VALIDATION' : ['NOT_FOUND', 'STALE_REVISION', 'BACKGROUND_AI_UNAVAILABLE'].includes(error.message) ? error.message : 'BACKGROUND_AI_ERROR';
    return c.json({ error: { code, message: code.toLowerCase() } }, code === 'STALE_REVISION' ? 409 : code === 'NOT_FOUND' ? 404 : 400);
  });
  app.get('/dashboard/api/v1/background-ai', (c) => c.json({ data: service.status(actor(c.get('session'))) }));
  app.post('/dashboard/api/v1/background-ai', async (c) => {
    const input = z.object({ enabled: z.boolean(), expectedRevision: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    return c.json({ data: service.set(actor(c.get('session')), input.enabled, input.expectedRevision) });
  });
  root.route('/', app);
}
