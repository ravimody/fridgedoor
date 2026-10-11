import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { CaptureCredentialService } from './capture.js';
const now = new Date('2026-01-01T00:00:00.000Z');
function seed() { const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString()); return db; }
describe('capture credentials', () => { it('shows plaintext only at creation and revokes immediately', () => { const db = seed(); const service = new CaptureCredentialService(db, () => now); const actor = { memberId: 'm1', householdId: 'h1' }; const created = service.create(actor, 'Phone'); expect(created.token).toHaveLength(43); expect(service.verify(created.token).memberId).toBe('m1'); expect(service.revoke(actor, created.id)).toEqual({ revoked: true }); expect(() => service.verify(created.token)).toThrow('CAPTURE_CREDENTIAL_INVALID'); }); });
