import type { Hono } from 'hono';
import type { Variables } from '../app.js';
import type { MemberRecord } from '../auth/access.js';
import type { CalendarRepository } from '../repos/calendar.js';
type Deps = { calendars: CalendarRepository; memberFor: (subject: string) => MemberRecord | undefined };
export function registerAgendaRoutes(app: Hono<{ Variables: Variables }>, deps: Deps) { app.get('/dashboard/api/v1/agenda', (c) => { const identity = c.get('identity') as { subject: string }; const session = c.get('session') as { member: MemberRecord }; const member = deps.memberFor(identity.subject); if (!member || member.id !== session.member.id) return c.json({ error: { code: 'UNAUTHENTICATED', message: 'unauthenticated', requestId: c.get('requestId') } }, 401); return c.json({ data: { items: deps.calendars.agendaSafe({ memberId: member.id, householdId: member.householdId }) } }, 200, { 'Cache-Control': 'no-store' }); }); }
