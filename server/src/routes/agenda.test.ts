import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { migrate } from '../db/migrate.js';

const config = { NODE_ENV: 'test' as const, DATABASE_PATH: ':memory:', SESSION_SECRET: 'test-session-secret-change-me-1234567890', APP_ORIGIN: 'https://planner.example.test' };
describe('agenda route', () => { it('requires the browser session before reading agenda', async () => { const db = new Database(':memory:'); migrate(db); const app = createApp({ db, config, members: () => [], verifyAccess: async () => null }); const response = await app.request('/dashboard/api/v1/agenda'); expect(response.status).toBe(401); }); });
