import { z, ZodError } from 'zod';
import type { Hono } from 'hono';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import type { PlanDecisionService } from '../services/plan-decisions.js';
import type { CalendarActionService } from '../services/calendar-actions.js';

type RouteDeps = { actions: CalendarActionService; decisions?: PlanDecisionService; memberFor: (subject: string) => MemberRecord | undefined };
function actor(c: { get: (key: 'identity'|'session') => unknown }, deps: RouteDeps) { const identity = c.get('identity') as { subject: string }; const session = c.get('session') as { member: MemberRecord }; const member = deps.memberFor(identity.subject); if (!member || member.id !== session.member.id) throw new Error('UNAUTHENTICATED'); return { memberId: member.id, householdId: member.householdId }; }
function error(c: { json: (body: unknown, status: 400|401|403|404|409|422) => Response; get: (key: 'requestId') => string }, value: unknown) { const code = value instanceof ZodError ? 'VALIDATION' : value instanceof Error ? value.message : 'ACTION_ERROR'; const status = code === 'STALE_REVISION' || code === 'IDEMPOTENCY_CONFLICT' ? 409 : code === 'VALIDATION' ? 422 : code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : code === 'UNAUTHENTICATED' ? 401 : 400; return c.json({ error: { code, message: code.replaceAll('_', ' ').toLowerCase(), requestId: c.get('requestId') } }, status as 400|401|403|404|409|422); }
export function registerActionRoutes(app: Hono<{ Variables: Variables }>, deps: RouteDeps) {
  app.post('/dashboard/api/v1/plans/:id/decision', async (c) => { try { const input = z.object({ expectedRevision: z.number().int().positive(), choice: z.enum(['keep', 'calendar']) }).strict().parse(await c.req.json()); if (!deps.decisions) throw new Error('UNAVAILABLE'); return c.json({ data: deps.decisions.decide(actor(c, deps), c.req.param('id'), input.expectedRevision, input.choice) }); } catch (value) { return error(c, value); } });
  app.post('/dashboard/api/v1/plans/:id/apply', async (c) => { try { const input = z.object({ expectedRevision: z.number().int().positive(), kind: z.enum(['create', 'update', 'cancel']) }).strict().parse(await c.req.json()); const key = c.req.header('Idempotency-Key'); if (!key) throw new Error('IDEMPOTENCY_REQUIRED'); return c.json({ data: deps.actions.apply(actor(c, deps), c.req.param('id'), input.expectedRevision, input.kind, key) }, 202); } catch (value) { return error(c, value); } });
  app.post('/dashboard/api/v1/actions/:id/retry', async (c) => { try { const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await c.req.json()); return c.json({ data: deps.actions.retry(actor(c, deps), c.req.param('id'), input.expectedRevision) }, 202); } catch (value) { return error(c, value); } });
  app.get('/dashboard/api/v1/actions/:id', (c) => { try { return c.json({ data: deps.actions.status(actor(c, deps), c.req.param('id')) }, 200, { 'Cache-Control': 'no-store' }); } catch (value) { return error(c, value); } });
}
