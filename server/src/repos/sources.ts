import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { digest, encryptJson, indexKey } from '../crypto.js';
import { JobQueue } from '../jobs/queue.js';
import type { SourceMedia } from '../sync/attachments.js';

export type SourceEvidence = {
  providerId: string; threadId?: string; subject?: string; sender?: string; labels: string[];
  text: string; internalDate?: string; messageId?: string; references?: string[];
  attachmentsIncomplete: boolean; media?: SourceMedia[];
};
export type SyncState = {
  id: string; connectionId: string; sourceKind: string; streamKey: string; cursor: string | null;
  initialAnchor: string | null; pageToken: string | null; queryVersion: string; lastSuccessAt: string | null;
  errorCode: string | null; generation: number; streamLeaseToken: string | null; streamLeaseUntil: string | null;
};
type SyncRow = { id: string; connection_id: string; source_kind: string; stream_key: string; cursor: string | null; initial_anchor: string | null; page_token: string | null; query_version: string; last_success_at: string | null; error_code: string | null; generation: number; stream_lease_token: string | null; stream_lease_until: string | null };
const syncState = (row: SyncRow): SyncState => ({ id: row.id, connectionId: row.connection_id, sourceKind: row.source_kind, streamKey: row.stream_key, cursor: row.cursor, initialAnchor: row.initial_anchor, pageToken: row.page_token, queryVersion: row.query_version, lastSuccessAt: row.last_success_at, errorCode: row.error_code, generation: row.generation, streamLeaseToken: row.stream_lease_token, streamLeaseUntil: row.stream_lease_until });

export class SourceRepository {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: () => Date = () => new Date()) {}

  ensureGmailState(connectionId: string, generation: number, queryVersion = 'gmail-v1') {
    const now = this.clock().toISOString();
    const existing = this.getGmailState(connectionId);
    if (!existing) this.db.prepare(`INSERT INTO sync_states (id, connection_id, source_kind, stream_key, query_version, generation, created_at, updated_at)
      VALUES (?, ?, 'gmail', 'mailbox', ?, ?, ?, ?)`).run(randomBytes(16).toString('hex'), connectionId, queryVersion, generation, now, now);
    else if (existing.generation !== generation) this.db.prepare("UPDATE sync_states SET cursor = NULL, initial_anchor = NULL, page_token = NULL, query_version = ?, generation = ?, error_code = NULL, stream_lease_token = NULL, stream_lease_until = NULL, updated_at = ? WHERE id = ?").run(queryVersion, generation, now, existing.id);
    else this.db.prepare('UPDATE sync_states SET updated_at = ? WHERE id = ?').run(now, existing.id);
    return this.getGmailState(connectionId)!;
  }
  getGmailState(connectionId: string) { const row = this.db.prepare("SELECT * FROM sync_states WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox'").get(connectionId) as SyncRow | undefined; return row ? syncState(row) : undefined; }
  setAnchor(connectionId: string, generation: number, anchor: string) {
    const now = this.clock().toISOString();
    this.db.prepare("UPDATE sync_states SET initial_anchor = COALESCE(initial_anchor, ?), generation = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox'").run(anchor, generation, now, connectionId);
  }
  setPage(connectionId: string, pageToken: string | null, generation: number) {
    this.db.prepare("UPDATE sync_states SET page_token = ?, generation = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox'").run(pageToken, generation, this.clock().toISOString(), connectionId);
  }
  setQueryVersion(connectionId: string, queryVersion: string) { this.db.prepare("UPDATE sync_states SET query_version = ?, page_token = NULL, updated_at = ? WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox'").run(queryVersion, this.clock().toISOString(), connectionId); }
  complete(connectionId: string, cursor: string, generation: number) {
    const now = this.clock().toISOString();
    this.db.prepare("UPDATE sync_states SET cursor = ?, page_token = NULL, initial_anchor = NULL, last_success_at = ?, error_code = NULL, generation = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox'").run(cursor, now, generation, now, connectionId);
  }
  markError(connectionId: string, errorCode: string) { this.db.prepare("UPDATE sync_states SET error_code = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox'").run(errorCode, this.clock().toISOString(), connectionId); }
  resetCursor(connectionId: string, generation: number) { this.db.prepare("UPDATE sync_states SET cursor = NULL, initial_anchor = NULL, page_token = NULL, query_version = 'gmail-v1', error_code = NULL, generation = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox'").run(generation, this.clock().toISOString(), connectionId); }
  acquireStream(connectionId: string, generation: number, leaseMs = 60_000) {
    const now = this.clock(); const token = randomBytes(24).toString('base64url');
    const result = this.db.prepare("UPDATE sync_states SET stream_lease_token = ?, stream_lease_until = ?, generation = ?, updated_at = ? WHERE connection_id = ? AND source_kind = 'gmail' AND stream_key = 'mailbox' AND generation = ? AND (stream_lease_until IS NULL OR stream_lease_until <= ?)")
      .run(token, new Date(now.getTime() + leaseMs).toISOString(), generation, now.toISOString(), connectionId, generation, now.toISOString());
    return result.changes === 1 ? token : null;
  }
  releaseStream(connectionId: string, token: string) { this.db.prepare("UPDATE sync_states SET stream_lease_token = NULL, stream_lease_until = NULL, updated_at = ? WHERE connection_id = ? AND stream_lease_token = ?").run(this.clock().toISOString(), connectionId, token); }

  persistMessage(input: { memberId: string; householdId: string; connectionId: string; generation: number; message: SourceEvidence; queue: JobQueue }) {
    const now = this.clock().toISOString();
    const providerKey = indexKey(input.message.providerId, this.key);
    const sourceId = randomBytes(16).toString('hex');
    const evidence = JSON.stringify(input.message);
    const contentDigest = digest(evidence);
    const versionId = randomBytes(16).toString('hex');
    const extractionKey = `extract:${sourceId}:${contentDigest}`;
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id, current_version_id, generation FROM source_items WHERE owner_id = ? AND kind = ? AND provider_key = ?').get(input.memberId, 'gmail_message', providerKey) as { id: string; current_version_id: string | null; generation: number } | undefined;
      const id = existing?.id ?? sourceId;
      let version: string | null = null;
      if (!existing) {
        this.db.prepare(`INSERT INTO source_items (id, household_id, owner_id, connection_id, kind, provider_key, encrypted_provider_refs, current_version_id, state, generation, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'gmail_message', ?, ?, NULL, 'available', ?, ?, ?)`).run(id, input.householdId, input.memberId, input.connectionId, providerKey, JSON.stringify(encryptJson({ providerId: input.message.providerId, threadId: input.message.threadId }, this.key, `source:${id}`)), input.generation, now, now);
      } else {
        this.db.prepare("UPDATE source_items SET connection_id = ?, state = 'available', generation = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND generation <= ?").run(input.connectionId, input.generation, now, id, input.memberId, input.generation);
        const oldDigest = existing.current_version_id ? (this.db.prepare('SELECT content_digest FROM source_versions WHERE id = ?').get(existing.current_version_id) as { content_digest: string } | undefined)?.content_digest : undefined;
        if (oldDigest === contentDigest) return { sourceId: id, versionId: existing.current_version_id, changed: false };
      }
      const sequence = Number((this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM source_versions WHERE source_id = ?').get(id) as { value: number }).value) + 1;
      this.db.prepare(`INSERT INTO source_versions (id, source_id, sequence, content_digest, encrypted_evidence, observed_at, original_at, expires_at, availability, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`).run(versionId, id, sequence, contentDigest, JSON.stringify(encryptJson(input.message, this.key, `source-version:${versionId}`)), now, input.message.internalDate ?? null, new Date(this.clock().getTime() + 7 * 86400000).toISOString(), JSON.stringify({ attachmentsIncomplete: input.message.attachmentsIncomplete }));
      this.db.prepare('UPDATE source_items SET current_version_id = ?, updated_at = ? WHERE id = ?').run(versionId, now, id);
      input.queue.enqueue({ kind: 'extract_source', scopeId: input.connectionId, dedupeKey: extractionKey, payload: { connectionId: input.connectionId, generation: input.generation, sourceVersionId: versionId } });
      version = versionId;
      return { sourceId: id, versionId: version, changed: true };
    });
    return transaction();
  }

  markDeleted(memberId: string, connectionId: string, generation: number, providerId: string) {
    const providerKey = indexKey(providerId, this.key);
    const now = this.clock().toISOString();
    const transaction = this.db.transaction(() => {
      const result = this.db.prepare("UPDATE source_items SET state = 'deleted', generation = ?, updated_at = ? WHERE owner_id = ? AND connection_id = ? AND kind = 'gmail_message' AND provider_key = ?").run(generation, now, memberId, connectionId, providerKey);
      this.db.prepare("UPDATE source_versions SET availability = 'deleted', encrypted_evidence = '' WHERE source_id IN (SELECT id FROM source_items WHERE owner_id = ? AND connection_id = ? AND kind = 'gmail_message' AND provider_key = ?)").run(memberId, connectionId, providerKey);
      return result.changes;
    });
    return transaction();
  }
  purgePrivate(connectionId: string) {
    this.db.prepare('DELETE FROM source_items WHERE connection_id = ?').run(connectionId);
    this.db.prepare("UPDATE jobs SET state = 'canceled', error_code = 'PRIVATE_DATA_DELETED', lease_token = NULL, lease_until = NULL WHERE scope_id = ? AND state IN ('ready', 'retry_wait', 'running')").run(connectionId);
  }
}
