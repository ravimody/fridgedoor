import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { migrate } from '../db/migrate.js';
import { FakeGoogleProvider } from '../providers/google.js';

describe('connection routes', () => { it('requires the caller session and returns only connection status', async () => { const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', new Date().toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, new Date().toISOString()); const app = createApp({ db, config: { NODE_ENV: 'test', DATABASE_PATH: ':memory:', SESSION_SECRET: 'test-session-secret-change-me-1234567890', APP_ORIGIN: 'https://planner.example.test' }, members: () => [{ id: 'm1', householdId: 'h1', accessSubject: 's1', displayName: 'Alex', timezone: 'America/New_York', active: true }], verifyAccess: async (token) => token === 'valid' ? { subject: 's1' } : null, google: new FakeGoogleProvider() }); const response = await app.request('/dashboard/api/v1/connection', { headers: { Authorization: 'Bearer valid' } }); expect(response.status).toBe(401); }); });
