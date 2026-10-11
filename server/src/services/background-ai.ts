import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { JobQueue } from '../jobs/queue.js';
import { lazy, type Lazy } from '../llm/hub.js';

export const BACKGROUND_AI_CONSENT = 'background-ai-v1';
export const BACKGROUND_AI_HOURLY_LIMIT = 500;
export const BACKGROUND_AI_DAILY_LIMIT = 3000;
export const BACKGROUND_AI_HOURLY_WARNING = 250;
export const BACKGROUND_AI_DAILY_WARNING = 1000;
type Actor = { memberId: string; householdId: string };

export class BackgroundAiService {
  /** `available` and `providerInfo` may be getters so AI settings changes apply without a restart. */
  constructor(private readonly db: Database.Database, private readonly available: Lazy<boolean>, private readonly clock: () => Date = () => new Date(), private readonly providerInfo: Lazy<{ provider?: string | undefined; model?: string | undefined }> = {}) {}
  private member(actor: Actor) {
    if (!this.db.prepare('SELECT 1 FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId)) throw new Error('NOT_FOUND');
  }
  status(actor: Actor) {
    this.member(actor);
    const row = this.db.prepare('SELECT enabled, consent_version, revision FROM background_ai_settings WHERE member_id = ?').get(actor.memberId) as { enabled: number; consent_version: string; revision: number } | undefined;
    const connection = this.db.prepare('SELECT status FROM google_connections WHERE member_id = ?').get(actor.memberId) as { status: string } | undefined;
    const since = new Date(this.clock().getTime() - 86400000).toISOString();
    const usage = this.db.prepare('SELECT count(*) AS n FROM background_ai_attempts WHERE member_id = ? AND attempted_at > ?').get(actor.memberId, since) as { n: number };
    const hourly = this.db.prepare('SELECT count(*) AS n FROM background_ai_attempts WHERE member_id = ? AND attempted_at > ?').get(actor.memberId, new Date(this.clock().getTime() - 3600000).toISOString()) as { n: number };
    const volumeWarning = hourly.n >= BACKGROUND_AI_HOURLY_WARNING || usage.n >= BACKGROUND_AI_DAILY_WARNING;
    const pausedForVolume = hourly.n >= BACKGROUND_AI_HOURLY_LIMIT || usage.n >= BACKGROUND_AI_DAILY_LIMIT;
    const last = this.db.prepare(`SELECT max(e.updated_at) AS at FROM extractions e JOIN source_versions sv ON sv.id = e.source_version_id
      JOIN source_items si ON si.id = sv.source_id WHERE si.owner_id = ? AND e.state = 'succeeded'`).get(actor.memberId) as { at: string | null };
    const pending = this.db.prepare(`SELECT count(*) AS n FROM jobs j JOIN google_connections g ON g.id = j.scope_id
      WHERE g.member_id = ? AND j.kind = 'extract_source' AND j.state IN ('ready','running','retry_wait')`).get(actor.memberId) as { n: number };
    const failures = this.db.prepare(`SELECT count(*) AS n FROM extractions e JOIN source_versions sv ON sv.id = e.source_version_id
      JOIN source_items si ON si.id = sv.source_id WHERE si.owner_id = ? AND e.state = 'failed' AND e.updated_at > ?`).get(actor.memberId, since) as { n: number };
    const info = lazy(this.providerInfo);
    return { provider: info.provider ?? null, model: info.model ?? null, failuresLastDay: failures.n, available: lazy(this.available), enabled: Boolean(row?.enabled && row.consent_version === BACKGROUND_AI_CONSENT), revision: row?.revision ?? 0, connectionActive: connection?.status === 'active', attemptsLastDay: usage.n, attemptsLastHour: hourly.n, volumeWarning, pausedForVolume, dailyLimit: BACKGROUND_AI_DAILY_LIMIT, hourlyLimit: BACKGROUND_AI_HOURLY_LIMIT, pending: pending.n, lastProcessedAt: last.at };
  }
  set(actor: Actor, enabled: boolean, expectedRevision: number) {
    return this.db.transaction(() => {
      const current = this.status(actor);
      if (current.revision !== expectedRevision) throw new Error('STALE_REVISION');
      if (enabled && !lazy(this.available)) throw new Error('BACKGROUND_AI_UNAVAILABLE');
      this.db.prepare(`INSERT INTO background_ai_settings (member_id, enabled, consent_version, revision, updated_at) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(member_id) DO UPDATE SET enabled = excluded.enabled, consent_version = excluded.consent_version,
        revision = background_ai_settings.revision + 1, updated_at = excluded.updated_at`).run(actor.memberId, enabled ? 1 : 0, BACKGROUND_AI_CONSENT, this.clock().toISOString());
      this.db.prepare(`UPDATE jobs SET state = 'canceled', error_code = 'BACKGROUND_AI_CHANGED', lease_token = NULL, lease_until = NULL
        WHERE kind = 'extract_source' AND scope_id IN (SELECT id FROM google_connections WHERE member_id = ?) AND state IN ('ready','retry_wait','running')`).run(actor.memberId);
      if (enabled) {
        const sources = this.db.prepare(`SELECT sv.id, g.id AS connectionId, g.generation FROM source_versions sv JOIN source_items si ON si.id = sv.source_id
          JOIN google_connections g ON g.id = si.connection_id WHERE si.owner_id = ? AND si.kind = 'gmail_message'
          AND g.member_id = si.owner_id AND g.status = 'active' AND si.generation = g.generation
          AND si.current_version_id = sv.id AND si.state = 'available' AND sv.availability = 'available' AND sv.expires_at > ?
          ORDER BY COALESCE(sv.original_at, sv.observed_at) DESC, sv.observed_at DESC LIMIT 100`).all(actor.memberId, this.clock().toISOString()) as { id: string; connectionId: string; generation: number }[];
        const queue = new JobQueue(this.db, this.clock);
        for (const source of sources) queue.enqueue({ kind: 'extract_source', scopeId: source.connectionId, dedupeKey: `background-optin:${source.id}:${current.revision + 1}`, payload: { sourceVersionId: source.id, connectionId: source.connectionId, generation: source.generation } });
      }
      return this.status(actor);
    })();
  }
  reserve(memberId: string, sourceVersionId: string, model: string): 'reserved' | 'capacity' | 'exhausted' {
    return this.db.transaction(() => {
      const now = this.clock();
      const count = (where: string, ...args: string[]) => (this.db.prepare(`SELECT count(*) AS n FROM background_ai_attempts WHERE ${where}`).get(...args) as { n: number }).n;
      if (count('source_version_id = ? AND model = ?', sourceVersionId, model) >= 3) return 'exhausted';
      if (count('member_id = ? AND attempted_at > ?', memberId, new Date(now.getTime() - 3600000).toISOString()) >= BACKGROUND_AI_HOURLY_LIMIT || count('member_id = ? AND attempted_at > ?', memberId, new Date(now.getTime() - 86400000).toISOString()) >= BACKGROUND_AI_DAILY_LIMIT) return 'capacity';
      this.db.prepare('INSERT INTO background_ai_attempts VALUES (?, ?, ?, ?, ?)').run(randomUUID(), memberId, sourceVersionId, model, now.toISOString());
      return 'reserved';
    })();
  }
}
