import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptJson, encryptJson, type Envelope } from '../crypto.js';

export type KnowledgeActor = { memberId: string; householdId: string };
export type KnowledgeInput = { key: string; value: string; expectedRevision: number; provenance?: 'legacy'|'user'|'source'|'maintenance'; confirmation?: 'confirmed'|'unconfirmed'; validFrom?: string | null; validUntil?: string | null; relationKey?: string | null; sourceManifest?: unknown; reason?: string; origin?: 'user'|'review'|'maintenance' };
export type KnowledgeFact = { key: string; value: string; revision: number; provenance: 'legacy'|'user'|'source'|'maintenance'; confirmation: 'confirmed'|'unconfirmed'; validFrom: string | null; validUntil: string | null; relationKey: string | null; archivedAt: string | null };
type Row = { owner_id: string; fact_key: string; encrypted_value: string; updated_at: string; revision: number; provenance: KnowledgeFact['provenance']; confirmation: KnowledgeFact['confirmation']; valid_from: string | null; valid_until: string | null; relation_key: string | null; archived_at: string | null; encrypted_source_manifest: string | null };
type ChangeRow = { id: string; owner_id: string; fact_key: string; base_revision: number; result_revision: number; encrypted_before: string | null; encrypted_after: string | null; origin: 'user'|'review'|'maintenance'; reason: string; encrypted_source_manifest: string; created_at: string; undo_until: string };
type Clock = () => Date;

export class KnowledgeRepository {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: Clock = () => new Date()) {}
  private member(actor: KnowledgeActor) { const row = this.db.prepare('SELECT timezone FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId) as { timezone: string } | undefined; if (!row) throw new Error('NOT_FOUND'); return row; }
  private encode(value: unknown, context: string) { return JSON.stringify(encryptJson(value, this.key, context)); }
  private decode<T>(value: string, context: string) { return decryptJson<T>(JSON.parse(value) as Envelope, this.key, context); }
  list(actor: KnowledgeActor): KnowledgeFact[] { this.member(actor); return (this.db.prepare("SELECT * FROM assistant_knowledge WHERE owner_id = ? AND archived_at IS NULL ORDER BY fact_key").all(actor.memberId) as Row[]).map((row) => this.view(row)); }
  context(actor: KnowledgeActor, startDate: string, endDateExclusive: string) {
    this.member(actor);
    return this.list(actor).filter((fact) => (!fact.validFrom || fact.validFrom < endDateExclusive) && (!fact.validUntil || fact.validUntil > startDate)).map((fact) => ({ key: fact.key, value: fact.value, validity: fact.validFrom && fact.validFrom > startDate ? 'future' as const : 'current' as const, revision: fact.revision, provenance: fact.provenance, confirmation: fact.confirmation, validFrom: fact.validFrom, validUntil: fact.validUntil }));
  }
  get(actor: KnowledgeActor, key: string) { this.member(actor); const row = this.db.prepare("SELECT * FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ? AND archived_at IS NULL").get(actor.memberId, key) as Row | undefined; return row ? this.view(row) : undefined; }
  set(actor: KnowledgeActor, input: KnowledgeInput) {
    this.member(actor); this.validate(input);
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ? AND archived_at IS NULL').get(actor.memberId, input.key) as Row | undefined;
      const baseRevision = current?.revision ?? 0;
      if (input.expectedRevision !== baseRevision) throw new Error('STALE_REVISION');
      if (!current && (this.db.prepare("SELECT COUNT(*) AS count FROM assistant_knowledge WHERE owner_id = ? AND archived_at IS NULL").get(actor.memberId) as { count: number }).count >= 50) throw new Error('KNOWLEDGE_LIMIT');
      const resultRevision = baseRevision + 1; const id = randomBytes(16).toString('hex'); const now = this.clock();
      this.db.prepare('DELETE FROM knowledge_tombstones WHERE owner_id = ? AND fact_key = ?').run(actor.memberId, input.key);
      const origin = input.origin ?? (input.provenance === 'maintenance' || input.provenance === 'source' ? 'maintenance' : 'user');
      this.change(id, actor.memberId, input.key, baseRevision, resultRevision, current ? this.decode<string>(current.encrypted_value, `knowledge:${actor.memberId}:${input.key}`) : null, input.value, origin, input.reason ?? 'user-edit', input.sourceManifest ?? [], now);
      const encryptedValue = this.encode(input.value, `knowledge:${actor.memberId}:${input.key}`); const sourceManifest = input.sourceManifest === undefined ? null : this.encode(input.sourceManifest, `knowledge:${actor.memberId}:${input.key}:sources`);
      if (current) this.db.prepare(`UPDATE assistant_knowledge SET encrypted_value = ?, updated_at = ?, revision = ?, provenance = ?, confirmation = ?, valid_from = ?, valid_until = ?, relation_key = ?, encrypted_source_manifest = ? WHERE owner_id = ? AND fact_key = ? AND revision = ?`).run(encryptedValue, now.toISOString(), resultRevision, input.provenance ?? 'user', input.confirmation ?? 'confirmed', input.validFrom ?? null, input.validUntil ?? null, input.relationKey ?? null, sourceManifest, actor.memberId, input.key, baseRevision);
      else this.db.prepare(`INSERT INTO assistant_knowledge (owner_id, fact_key, encrypted_value, updated_at, revision, provenance, confirmation, valid_from, valid_until, archived_at, relation_key, encrypted_source_manifest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(actor.memberId, input.key, encryptedValue, now.toISOString(), resultRevision, input.provenance ?? 'user', input.confirmation ?? 'confirmed', input.validFrom ?? null, input.validUntil ?? null, input.relationKey ?? null, sourceManifest);
      return this.get(actor, input.key)!;
    })();
  }
  forget(actor: KnowledgeActor, key: string, expectedRevision: number) {
    this.member(actor); return this.db.transaction(() => { const current = this.db.prepare("SELECT revision FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ? AND archived_at IS NULL").get(actor.memberId, key) as { revision: number } | undefined; if ((current?.revision ?? 0) !== expectedRevision) throw new Error('STALE_REVISION'); this.db.prepare('DELETE FROM knowledge_changes WHERE owner_id = ? AND fact_key = ?').run(actor.memberId, key); this.db.prepare('DELETE FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ?').run(actor.memberId, key); this.db.prepare('INSERT INTO knowledge_tombstones (owner_id, fact_key, deleted_revision, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, fact_key) DO UPDATE SET deleted_revision = excluded.deleted_revision, created_at = excluded.created_at').run(actor.memberId, key, expectedRevision, this.clock().toISOString()); return { deleted: Boolean(current) }; })();
  }
  isForgotten(actor: KnowledgeActor, key: string) { this.member(actor); return Boolean(this.db.prepare('SELECT 1 FROM knowledge_tombstones WHERE owner_id = ? AND fact_key = ?').get(actor.memberId, key)); }
  archive(actor: KnowledgeActor, key: string, expectedRevision: number, reason = 'maintenance-expiry', sourceManifest: unknown = []) {
    this.member(actor); return this.db.transaction(() => {
      const current = this.db.prepare('SELECT * FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ?').get(actor.memberId, key) as Row | undefined;
      if (!current || current.revision !== expectedRevision || current.archived_at) throw new Error(current?.revision === expectedRevision ? 'ALREADY_ARCHIVED' : 'STALE_REVISION');
      const now = this.clock(); const nextRevision = current.revision + 1; const value = this.decode<string>(current.encrypted_value, `knowledge:${actor.memberId}:${key}`);
      this.change(randomBytes(16).toString('hex'), actor.memberId, key, current.revision, nextRevision, value, value, 'maintenance', reason, sourceManifest, now);
      this.db.prepare('UPDATE assistant_knowledge SET archived_at = ?, revision = ?, provenance = \'maintenance\', updated_at = ? WHERE owner_id = ? AND fact_key = ? AND revision = ?').run(now.toISOString(), nextRevision, now.toISOString(), actor.memberId, key, current.revision);
      return { archived: true, revision: nextRevision };
    })();
  }
  history(actor: KnowledgeActor, key?: string) {
    this.member(actor); const rows = (this.db.prepare(`SELECT * FROM knowledge_changes WHERE owner_id = ? ${key ? 'AND fact_key = ?' : ''} ORDER BY created_at DESC`).all(...(key ? [actor.memberId, key] : [actor.memberId])) as ChangeRow[]);
    return rows.map((row) => ({ id: row.id, key: row.fact_key, baseRevision: row.base_revision, resultRevision: row.result_revision, before: row.encrypted_before ? this.decode<string>(row.encrypted_before, `knowledge-change:${row.id}:before`) : null, after: row.encrypted_after ? this.decode<string>(row.encrypted_after, `knowledge-change:${row.id}:after`) : null, origin: row.origin, reason: row.reason, createdAt: row.created_at, undoUntil: row.undo_until }));
  }
  undo(actor: KnowledgeActor, id: string, expectedRevision: number) {
    this.member(actor); return this.db.transaction(() => { const change = this.db.prepare('SELECT * FROM knowledge_changes WHERE id = ? AND owner_id = ?').get(id, actor.memberId) as ChangeRow | undefined; if (!change) throw new Error('NOT_FOUND'); if (change.undo_until <= this.clock().toISOString()) throw new Error('UNDO_UNAVAILABLE'); const current = this.db.prepare("SELECT * FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ?").get(actor.memberId, change.fact_key) as Row | undefined; if (!current || current.revision !== expectedRevision || current.revision !== change.result_revision) throw new Error('STALE_REVISION'); const before = change.encrypted_before ? this.decode<string>(change.encrypted_before, `knowledge-change:${id}:before`) : null; const now = this.clock(); const nextId = randomBytes(16).toString('hex'); this.change(nextId, actor.memberId, change.fact_key, current.revision, current.revision + 1, this.decode<string>(current.encrypted_value, `knowledge:${actor.memberId}:${change.fact_key}`), before, 'user', 'undo', [], now); if (before === null) this.db.prepare('DELETE FROM assistant_knowledge WHERE owner_id = ? AND fact_key = ? AND revision = ?').run(actor.memberId, change.fact_key, current.revision); else this.db.prepare('UPDATE assistant_knowledge SET encrypted_value = ?, revision = ?, archived_at = NULL, updated_at = ?, provenance = \'user\', confirmation = \'confirmed\' WHERE owner_id = ? AND fact_key = ? AND revision = ?').run(this.encode(before, `knowledge:${actor.memberId}:${change.fact_key}`), current.revision + 1, now.toISOString(), actor.memberId, change.fact_key, current.revision); return { undone: true, revision: current.revision + 1 }; })();
  }
  private change(id: string, ownerId: string, key: string, baseRevision: number, resultRevision: number, before: string | null, after: string | null, origin: ChangeRow['origin'], reason: string, sourceManifest: unknown, now: Date) { this.db.prepare(`INSERT INTO knowledge_changes (id, owner_id, fact_key, base_revision, result_revision, encrypted_before, encrypted_after, origin, reason, encrypted_source_manifest, created_at, undo_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ownerId, key, baseRevision, resultRevision, before === null ? null : this.encode(before, `knowledge-change:${id}:before`), after === null ? null : this.encode(after, `knowledge-change:${id}:after`), origin, reason, this.encode(sourceManifest, `knowledge-change:${id}:sources`), now.toISOString(), new Date(now.getTime() + 30 * 86400000).toISOString()); }
  private view(row: Row): KnowledgeFact { return { key: row.fact_key, value: this.decode<string>(row.encrypted_value, `knowledge:${row.owner_id}:${row.fact_key}`), revision: row.revision, provenance: row.provenance, confirmation: row.confirmation, validFrom: row.valid_from, validUntil: row.valid_until, relationKey: row.relation_key, archivedAt: row.archived_at }; }
  private validate(input: KnowledgeInput) { if (!input.key.trim() || input.key.length > 80 || !input.value.trim() || input.value.length > 500 || input.validFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom) || input.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) throw new Error('INVALID_FACT'); if (input.validFrom && input.validUntil && input.validFrom >= input.validUntil) throw new Error('INVALID_FACT'); }
}
