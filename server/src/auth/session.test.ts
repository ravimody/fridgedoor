import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { SessionStore } from './session.js';

const member = { id: 'm1', householdId: 'h1', accessSubject: 's1', displayName: 'Alex', timezone: 'America/New_York', active: true };
describe('browser sessions', () => { let db: Database.Database; beforeEach(() => { db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households VALUES (?, ?)').run('h1', new Date().toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, new Date().toISOString()); }); it('encrypts CSRF and binds lookup to member', () => { const store = new SessionStore(db, Buffer.alloc(32, 7)); const created = store.create(member); expect(store.find(created.token, member, () => member)?.csrfToken).toBe(created.data.csrfToken); expect(store.find(created.token, { ...member, id: 'other' }, () => member)).toBeNull(); expect(store.verifyCsrf(created.data, created.data.csrfToken)).toBe(true); expect(store.verifyCsrf(created.data, 'wrong')).toBe(false); }); it('is idempotent to migration', () => { migrate(db); expect(db.prepare('SELECT count(*) as count FROM browser_sessions').get()).toEqual({ count: 0 }); }); });
