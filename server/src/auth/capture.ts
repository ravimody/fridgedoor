import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { digest } from '../crypto.js';
type Actor = { memberId: string; householdId: string }; type Clock = () => Date;
export class CaptureCredentialService {
  constructor(private readonly db: Database.Database, private readonly clock: Clock = () => new Date()) {}
  create(actor: Actor, label: string) { const token = randomBytes(32).toString('base64url'); const id = randomBytes(16).toString('hex'); this.db.prepare("INSERT INTO capture_credentials (id, member_id, label, token_digest, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(id, actor.memberId, label.slice(0, 80), digest(token), this.clock().toISOString()); return { id, label: label.slice(0, 80), token }; }
  list(actor: Actor) { return this.db.prepare('SELECT id, label, status, created_at as createdAt, revoked_at as revokedAt, last_used_at as lastUsedAt FROM capture_credentials WHERE member_id = ? ORDER BY created_at').all(actor.memberId); }
  revoke(actor: Actor, id: string) { const result = this.db.prepare("UPDATE capture_credentials SET status = 'revoked', revoked_at = ? WHERE id = ? AND member_id = ? AND status = 'active'").run(this.clock().toISOString(), id, actor.memberId); if (result.changes !== 1) throw new Error('NOT_FOUND'); return { revoked: true }; }
  verify(token: string) { const row = this.db.prepare("SELECT id, member_id as memberId FROM capture_credentials WHERE token_digest = ? AND status = 'active'").get(digest(token)) as { id: string; memberId: string }|undefined; if (!row) throw new Error('CAPTURE_CREDENTIAL_INVALID'); this.db.prepare('UPDATE capture_credentials SET last_used_at = ? WHERE id = ?').run(this.clock().toISOString(), row.id); return row; }
}
