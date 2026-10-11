import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export type JobState = 'ready' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled';
export type JobKind = 'morning_digest' | 'daily_overview' | 'daily_maintenance' | 'relevance_learning' | 'capture_dispatch' | 'assistant' | 'gmail_sync' | 'calendar_sync' | 'retention' | 'extract_source' | 'calendar_action' | 'reminder_delivery';
export type JobPayload = { captureId?: string; assistantRunId?: string; connectionId?: string; generation?: number; streamId?: string; calendarSelectionId?: string; sourceVersionId?: string; actionId?: string; ownerId?: string; householdId?: string; localDate?: string; timezone?: string; consentRevision?: number; logicalRequest?: string };
export type JobRecord = {
  id: string; kind: JobKind; scopeId: string; dedupeKey: string; payload: JobPayload; state: JobState;
  runAfter: string; attemptCount: number; leaseToken: string | null; leaseUntil: string | null; errorCode: string | null;
};
type Row = Omit<JobRecord, 'payload'> & { payload_json: string; run_after: string; attempt_count: number; lease_token: string | null; lease_until: string | null; error_code: string | null; scope_id: string; dedupe_key: string };

const toRecord = (row: Row): JobRecord => ({
  id: row.id, kind: row.kind, scopeId: row.scope_id, dedupeKey: row.dedupe_key,
  payload: JSON.parse(row.payload_json) as JobPayload, state: row.state,
  runAfter: row.run_after, attemptCount: row.attempt_count, leaseToken: row.lease_token,
  leaseUntil: row.lease_until, errorCode: row.error_code,
});

export class JobQueue {
  constructor(private readonly db: Database.Database, private readonly clock: () => Date = () => new Date(), private readonly leaseMs = 60_000) {}

  enqueue(input: { kind: JobKind; scopeId: string; dedupeKey: string; payload: JobPayload; runAfter?: Date; reviveTerminal?: boolean }) {
    const now = this.clock().toISOString();
    const runAfter = (input.runAfter ?? this.clock()).toISOString();
    const id = randomBytes(16).toString('hex');
    this.db.prepare(`INSERT INTO jobs (id, kind, scope_id, dedupe_key, payload_json, state, run_after, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET run_after = MIN(jobs.run_after, excluded.run_after),
        state = CASE WHEN ? AND jobs.state IN ('failed', 'canceled') THEN 'ready' ELSE jobs.state END,
        error_code = CASE WHEN ? AND jobs.state IN ('failed', 'canceled') THEN NULL ELSE jobs.error_code END,
        updated_at = excluded.updated_at`).run(id, input.kind, input.scopeId, input.dedupeKey, JSON.stringify(input.payload), runAfter, now, now, Number(input.reviveTerminal ?? true), Number(input.reviveTerminal ?? true));
    return this.getByDedupe(input.dedupeKey)!;
  }

  get(id: string) { const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined; return row ? toRecord(row) : undefined; }
  getByDedupe(key: string) { const row = this.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(key) as Row | undefined; return row ? toRecord(row) : undefined; }

  claim(enabledKinds: readonly JobKind[]) {
    if (enabledKinds.length === 0) return undefined;
    const now = this.clock().toISOString();
    const leaseUntil = new Date(this.clock().getTime() + this.leaseMs).toISOString();
    const token = randomBytes(24).toString('base64url');
    const placeholders = enabledKinds.map(() => '?').join(',');
    const claim = this.db.transaction(() => {
      const candidate = this.db.prepare(`SELECT id FROM jobs WHERE state IN ('ready', 'retry_wait') AND run_after <= ?
        AND (lease_until IS NULL OR lease_until <= ?) AND kind IN (${placeholders}) ORDER BY CASE kind WHEN 'morning_digest' THEN 0 WHEN 'reminder_delivery' THEN 1 WHEN 'daily_overview' THEN 2 WHEN 'daily_maintenance' THEN 10 WHEN 'relevance_learning' THEN 11 ELSE 3 END, run_after, created_at LIMIT 1`).get(now, now, ...enabledKinds) as { id: string } | undefined;
      if (!candidate) return undefined;
      const result = this.db.prepare(`UPDATE jobs SET state = 'running', attempt_count = attempt_count + 1,
        lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ? AND state IN ('ready', 'retry_wait')
        AND (lease_until IS NULL OR lease_until <= ?)`).run(token, leaseUntil, now, candidate.id, now);
      if (result.changes !== 1) return undefined;
      return this.get(candidate.id);
    });
    return claim();
  }

  heartbeat(job: Pick<JobRecord, 'id' | 'leaseToken'>) {
    if (!job.leaseToken) return false;
    const now = this.clock();
    const result = this.db.prepare(`UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`)
      .run(new Date(now.getTime() + this.leaseMs).toISOString(), now.toISOString(), job.id, job.leaseToken, now.toISOString());
    return result.changes === 1;
  }

  finish(job: Pick<JobRecord, 'id' | 'leaseToken'>) {
    if (!job.leaseToken) return false;
    const result = this.db.prepare(`UPDATE jobs SET state = 'succeeded', lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`).run(this.clock().toISOString(), job.id, job.leaseToken, this.clock().toISOString());
    return result.changes === 1;
  }

  retry(job: Pick<JobRecord, 'id' | 'leaseToken'>, errorCode: string, runAfter: Date) {
    if (!job.leaseToken) return false;
    const result = this.db.prepare(`UPDATE jobs SET state = 'retry_wait', run_after = ?, error_code = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`).run(runAfter.toISOString(), errorCode, this.clock().toISOString(), job.id, job.leaseToken, this.clock().toISOString());
    return result.changes === 1;
  }

  fail(job: Pick<JobRecord, 'id' | 'leaseToken'>, errorCode: string) {
    if (!job.leaseToken) return false;
    const result = this.db.prepare(`UPDATE jobs SET state = 'failed', error_code = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`).run(errorCode, this.clock().toISOString(), job.id, job.leaseToken, this.clock().toISOString());
    return result.changes === 1;
  }

  cancelScope(scopeId: string, reason = 'CONNECTION_DISABLED') {
    return this.db.prepare(`UPDATE jobs SET state = 'canceled', error_code = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE scope_id = ? AND state IN ('ready', 'retry_wait', 'running')`).run(reason, this.clock().toISOString(), scopeId).changes;
  }

  reconcileCalendarActions() {
    // Also repairs actions left waiting by older workers. Terminal job state is
    // authoritative only for its matching durable calendar action.
    return this.db.prepare(`UPDATE calendar_actions SET
      state=CASE WHEN (SELECT state FROM jobs WHERE dedupe_key='calendar-action:' || calendar_actions.id)='canceled' THEN 'needs_reauth' ELSE 'failed' END,
      error_code='ACTION_JOB_STOPPED', updated_at=?
      WHERE state IN ('pending','running','reconciling') AND EXISTS (
        SELECT 1 FROM jobs WHERE kind='calendar_action' AND dedupe_key='calendar-action:' || calendar_actions.id AND state IN ('failed','canceled'))`).run(this.clock().toISOString()).changes;
  }

  recoverExpired() {
    return this.db.prepare(`UPDATE jobs SET state = 'retry_wait', lease_token = NULL, lease_until = NULL, run_after = ?, error_code = 'LEASE_EXPIRED', updated_at = ?
      WHERE state = 'running' AND lease_until <= ?`).run(this.clock().toISOString(), this.clock().toISOString(), this.clock().toISOString()).changes;
  }
}
