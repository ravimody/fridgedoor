import type { Hono } from 'hono';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import type { CaptureService } from '../services/captures.js';
import { captureErrorResponse as errorResponse, captureInput } from './shortcut-capture.js';
type D = { captures: CaptureService; memberFor: (subject: string) => MemberRecord|undefined };
const getActor = (c: { get: (key: 'identity'|'session') => unknown }, d: D) => { const identity = c.get('identity') as { subject: string }; const session = c.get('session') as { member: MemberRecord }; const member = d.memberFor(identity.subject); if (!member || member.id !== session.member.id) throw new Error('UNAUTHENTICATED'); return { memberId: member.id, householdId: member.householdId }; };
export function registerCaptureRoutes(app: Hono<{ Variables: Variables }>, d: D) { app.post('/dashboard/api/v1/captures', async (c) => { try { const actor = getActor(c, d); return c.json({ data: await d.captures.create(actor, await captureInput(c.req.raw)) }, 202); } catch (value) { return errorResponse(c, value); } }); app.get('/dashboard/api/v1/captures/:id', (c) => { try { return c.json({ data: d.captures.status(getActor(c, d), c.req.param('id')) }); } catch (value) { return errorResponse(c, value); } }); }
