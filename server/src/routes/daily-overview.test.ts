import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { FakeDailyOverviewProvider } from '../ai/daily-overview.js';
import { createApp } from '../app.js';
import { migrate } from '../db/migrate.js';

const config = { NODE_ENV: 'test' as const, DATABASE_PATH: ':memory:', SESSION_SECRET: 'test-session-secret-change-me-1234567890', APP_ORIGIN: 'https://planner.example.test' };

describe('daily overview routes', () => {
  it('requires consent, keeps reads synchronous, and deduplicates refresh jobs', async () => {
    const db = new Database(':memory:'); migrate(db); const now = new Date('2026-01-01T12:02:00.000Z');
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
    const member = { id: 'm1', householdId: 'h1', accessSubject: 'subject-alex', displayName: 'Owner', timezone: 'America/New_York', active: true };
    db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 'subject-alex', 'Owner', 'America/New_York', 1, now.toISOString());
    const provider = new FakeDailyOverviewProvider();
    const app = createApp({ db, config, now: () => now, dailyOverviewProvider: provider, members: () => [member], verifyAccess: async (token) => token === 'valid' ? { subject: 'subject-alex' } : null });
    const path = '/dashboard/api/v1/daily-ai-settings';
    expect((await app.request(path)).status).toBe(401);
    const bootstrap = await app.request('/dashboard/api/v1/session', { method: 'POST', headers: { Authorization: 'Bearer valid', Origin: config.APP_ORIGIN, 'X-Planner-Bootstrap': '1' } });
    const csrf = (await bootstrap.json()).data.csrfToken;
    const headers = { Authorization: 'Bearer valid', Cookie: bootstrap.headers.get('set-cookie')!, Origin: config.APP_ORIGIN, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
    expect((await app.request(path, { method: 'POST', headers, body: JSON.stringify({ enabled: true, expectedRevision: 0 }) })).status).toBe(400);
    const enabled = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ enabled: true, expectedRevision: 0, consentVersion: 'daily-assistant-v1' }) });
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).data).toMatchObject({ enabled: true, revision: 1, disclosureVersion: 'daily-assistant-v1' });
    const overview = await app.request('/dashboard/api/v1/daily-overview', { headers });
    expect(overview.status).toBe(200);
    expect((await overview.json()).data.state).toBe('unavailable');
    const first = await app.request('/dashboard/api/v1/daily-overview/refresh', { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) });
    const second = await app.request('/dashboard/api/v1/daily-overview/refresh', { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1 }) });
    expect(first.status).toBe(202); expect(second.status).toBe(202);
    expect((await first.json()).data.logicalId).toBe((await second.json()).data.logicalId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'daily_overview'").get()).toEqual({ count: 1 });
    expect(provider.calls).toBe(0);
    const dismissPath='/dashboard/api/v1/daily-overview/dismiss';
    expect((await app.request(dismissPath,{method:'POST',body:'{}'})).status).toBe(401);
    const {['X-CSRF-Token']:unused,...withoutCsrf}=headers;void unused;
    expect((await app.request(dismissPath,{method:'POST',headers:withoutCsrf,body:JSON.stringify({refs:['unknown'],expectedRevision:0})})).status).toBe(403);
    const restorePath='/dashboard/api/v1/daily-overview/restore';
    expect((await app.request(restorePath,{method:'POST',body:'{}'})).status).toBe(401);
    expect((await app.request(restorePath,{method:'POST',headers:withoutCsrf,body:JSON.stringify({undoToken:'bad'})})).status).toBe(403);
    expect((await app.request(restorePath,{method:'POST',headers,body:JSON.stringify({undoToken:'bad'})})).status).toBe(400);
    const invalidDismiss=await app.request(dismissPath,{method:'POST',headers,body:JSON.stringify({refs:['unknown'],expectedRevision:0})});
    expect(invalidDismiss.status).toBe(404);expect(invalidDismiss.headers.get('cache-control')).toBe('no-store');
    expect((await app.request(path, { method: 'POST', headers, body: JSON.stringify({ enabled: true, expectedRevision: 0, consentVersion: 'daily-assistant-v1' }) })).status).toBe(409);
    db.close();
  });
});
