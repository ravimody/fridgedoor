import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { PlanFacts } from '@fridgedoor/contracts';
import { createApp } from '../app.js';
import { keyFromSecret } from '../crypto.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { PlanRepository } from '../repos/plans.js';

const SECRET = 'test-session-secret-change-me-1234567890';
const ORIGIN = 'https://fridgedoor.example.test';
const base: PlanFacts = { title: 'Soccer practice, field 5', category: 'activities', participants: ['Alex'], location: 'Riverside Park; Field 5', notes: 'Bring water\nand cleats', preparationTasks: ['Pack shin guards'], unresolvedFields: [], time: { kind: 'timed', start: '2026-10-13T17:30:00-04:00', end: '2026-10-13T18:30:00-04:00', timezone: 'America/New_York' } };

async function setup() {
  const db = new Database(':memory:'); migrate(db);
  const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: SECRET, PUBLIC_URL: ORIGIN, SETUP_TOKEN: 'setup-token-abcdefghijkl' });
  const app = createApp({ db, config, now: () => new Date('2026-10-10T12:00:00Z') });
  const setupResponse = await app.request(`${ORIGIN}/dashboard/api/v1/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Host: 'fridgedoor.example.test' }, body: JSON.stringify({ token: 'setup-token-abcdefghijkl', householdName: 'The Riveras', displayName: 'Alex', email: 'alex@example.test', password: 'long enough password', timezone: 'America/New_York' }) });
  const body = await setupResponse.json() as { data: { csrfToken: string; member: { id: string; householdId: string } } };
  const headers = { Cookie: setupResponse.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token': body.data.csrfToken, Origin: ORIGIN };
  const plans = new PlanRepository(db, keyFromSecret(SECRET), () => new Date('2026-10-10T12:00:00Z'));
  const keep = (facts: PlanFacts) => { const id = plans.createPrivate({ memberId: body.data.member.id, householdId: body.data.member.householdId }, facts); db.prepare('UPDATE plans SET kept_at = ? WHERE id = ?').run('2026-10-10T12:00:00Z', id); return id; };
  return { app, db, headers, plans, keep, member: body.data.member };
}

describe('calendar subscription feed', () => {
  it('publishes saved plans as iCalendar events behind an unguessable link', async () => {
    const ctx = await setup();
    const id = ctx.keep(base);
    ctx.keep({ ...base, title: 'Permission slip', time: { kind: 'deadline', at: '2026-10-12T08:00:00-04:00', timezone: 'America/New_York' } });
    ctx.keep({ ...base, notes: 'line one\rX-INJECTED:1', title: 'Picture day', time: { kind: 'all_day', startDate: '2026-10-15', endDateExclusive: '2026-10-16' } });
    ctx.plans.createPrivate({ memberId: ctx.member.id, householdId: ctx.member.householdId }, { ...base, title: 'Unreviewed suggestion' });
    const created = await ctx.app.request('/dashboard/api/v1/calendar-feed', { method: 'POST', headers: ctx.headers });
    expect(created.status).toBe(201);
    const { data } = await created.json() as { data: { url: string; webcalUrl: string } };
    expect(data.webcalUrl.startsWith('webcal://fridgedoor.example.test/calendar/v1/')).toBe(true);
    const feed = await ctx.app.request(new URL(data.url).pathname);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const ics = await feed.text();
    expect(ics).toContain('X-WR-CALNAME:The Riveras (Fridgedoor)');
    expect(ics).toContain(`UID:${id}@fridgedoor`);
    expect(ics).toContain('DTSTART:20261013T213000Z');
    expect(ics).toContain('SUMMARY:Soccer practice\\, field 5');
    expect(ics).toContain('LOCATION:Riverside Park\\; Field 5');
    expect(ics).toContain('SUMMARY:Due: Permission slip');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261015');
    expect(ics).toContain('CLASS:PRIVATE');
    expect(ics).not.toContain('Unreviewed suggestion');
    expect(ics).not.toMatch(/\r(?!\n)/);
    expect(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);

    await ctx.app.request('/dashboard/api/v1/calendar-feed', { method: 'POST', headers: ctx.headers });
    expect((await ctx.app.request(new URL(data.url).pathname)).status).toBe(404);
    expect((await ctx.app.request('/calendar/v1/not-a-real-token.ics')).status).toBe(404);
  });
});
