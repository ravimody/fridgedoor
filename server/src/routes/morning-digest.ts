import { Hono } from 'hono';
import { z } from 'zod';
import type { Variables } from '../app.js';
import { errorHandler } from '../errors.js';
import type { MorningDigestService } from '../services/morning-digest.js';
import type { MemberRecord } from '../auth/access.js';
export function registerMorningDigestRoutes(root: Hono<{ Variables: Variables }>, service: MorningDigestService) {
  const app = new Hono<{ Variables: Variables }>();
  app.use('/dashboard/api/v1/morning-digest', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  const actor = (session: unknown) => { const member = (session as { member: MemberRecord }).member; return { memberId: member.id, householdId: member.householdId }; };
  app.onError(errorHandler({ NOT_FOUND: 404, STALE_REVISION: 409 }));
  app.get('/dashboard/api/v1/morning-digest', (c) => c.json({ data: service.status(actor(c.get('session'))) }));
  app.post('/dashboard/api/v1/morning-digest', async (c) => {
    const input = z.object({ enabled: z.boolean(), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), expectedRevision: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    return c.json({ data: service.set(actor(c.get('session')), input) });
  });
  root.route('/', app);
}
