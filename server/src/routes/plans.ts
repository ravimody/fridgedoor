import { z } from 'zod';
import type { Hono } from 'hono';
import type { Variables } from '../app.js';
import { codeOrThrow } from '../errors.js';
import type { MemberRecord } from '../auth/access.js';
import { dismissPlanSchema, planFactsPatchSchema, sharePlanSchema } from '@fridgedoor/contracts';
import type { PlanRepository } from '../repos/plans.js';

type RouteDeps = { plans: PlanRepository; memberFor: (subject: string) => MemberRecord | undefined };
const statusSchema = z.enum(['needs_details', 'proposed', 'dismissed', 'accepted', 'archived']);
function member(c: { get: (key: 'identity'|'session') => unknown }, deps: RouteDeps) { const identity = c.get('identity') as { subject: string }; const session = c.get('session') as { member: MemberRecord }; const current = deps.memberFor(identity.subject); if (!current || current.id !== session.member.id) throw new Error('UNAUTHENTICATED'); return current; }
function error(c: { json: (body: unknown, status: 401|403|404|409|422) => Response; get: (key: 'requestId') => string }, value: unknown) { const code = codeOrThrow(value); const status = code === 'STALE_REVISION' ? 409 : code === 'VALIDATION' ? 422 : code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' ? 403 : code === 'UNAUTHENTICATED' ? 401 : 400; return c.json({ error: { code, message: code.replaceAll('_', ' ').toLowerCase(), requestId: c.get('requestId') } }, status as 401|403|404|409|422); }
export function registerPlanRoutes(app: Hono<{ Variables: Variables }>, deps: RouteDeps) {
  app.get('/dashboard/api/v1/plans', (c) => { try { const actor = member(c, deps); const status = c.req.query('status'); return c.json({ data: { plans: deps.plans.list(actor.id, status ? statusSchema.parse(status) : undefined) } }, 200, { 'Cache-Control': 'no-store' }); } catch (value) { return error(c, value); } });
  app.get('/dashboard/api/v1/plans/:id', (c) => { try { const actor = member(c, deps); return c.json({ data: deps.plans.detail(c.req.param('id'), actor.id) }, 200, { 'Cache-Control': 'no-store' }); } catch (value) { return error(c, value); } });
  app.patch('/dashboard/api/v1/plans/:id', async (c) => { try { const actor = member(c, deps); const input = planFactsPatchSchema.parse(await c.req.json()); return c.json({ data: deps.plans.edit(c.req.param('id'), actor.id, input.expectedRevision, input.facts) }); } catch (value) { return error(c, value); } });
  app.post('/dashboard/api/v1/plans/:id/share', async (c) => { try { const actor = member(c, deps); const input = sharePlanSchema.parse(await c.req.json()); return c.json({ data: deps.plans.share(c.req.param('id'), actor.id, input.expectedRevision, input.reviewedFacts) }); } catch (value) { return error(c, value); } });
  app.post('/dashboard/api/v1/plans/:id/dismiss', async (c) => { try { const actor = member(c, deps); const input = dismissPlanSchema.parse(await c.req.json()); return c.json({ data: deps.plans.dismiss(c.req.param('id'), actor.id, input.expectedRevision) }); } catch (value) { return error(c, value); } });
  app.get('/dashboard/api/v1/plans/:id/history', (c) => { try { const actor = member(c, deps); return c.json({ data: { entries: deps.plans.history(c.req.param('id'), actor.id) } }, 200, { 'Cache-Control': 'no-store' }); } catch (value) { return error(c, value); } });
  app.get('/dashboard/api/v1/plans/:id/evidence', (c) => { try { const actor = member(c, deps); return c.json({ data: deps.plans.evidence(c.req.param('id'), actor.id, c.req.query('sourceVersionId')) }, 200, { 'Cache-Control': 'no-store' }); } catch (value) { return error(c, value); } });
}
