import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type AiUsageFeature = 'daily_overview' | 'daily_maintenance';
export type AiUsageValues = {
  outcome: string;
  durationMs?: number;
  inputTokens?: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  providerRequestId?: string;
};
export type ReservedAiUsageAttempt = { id: string; attempt: number };
type Clock = () => Date;

const ATTEMPT_LIMITS: Record<AiUsageFeature, number> = { daily_overview: 12, daily_maintenance: 1 };

export class AiUsageLimitError extends Error {
  constructor() { super('DAILY_AI_LIMIT'); }
}

export class AiUsageLedger {
  constructor(private readonly db: Database.Database, private readonly clock: Clock = () => new Date()) {}

  hasCapacity(ownerId: string, localDate: string, feature: AiUsageFeature) {
    const used=this.db.prepare('SELECT COUNT(*) AS count FROM ai_usage_attempts WHERE owner_id=? AND feature=? AND local_date=?').get(ownerId,feature,localDate) as {count:number};
    return used.count < ATTEMPT_LIMITS[feature];
  }

  reserve(input: { ownerId: string; feature: AiUsageFeature; logicalRequest: string; localDate: string; timezone: string; model: string; promptVersion: string }): ReservedAiUsageAttempt {
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT id, attempt, outcome FROM ai_usage_attempts
        WHERE owner_id = ? AND feature = ? AND logical_request = ? AND local_date = ?
        ORDER BY attempt DESC LIMIT 1`).get(input.ownerId, input.feature, input.logicalRequest, input.localDate) as { id: string; attempt: number; outcome: string } | undefined;
      if (existing && ['reserved', 'running'].includes(existing.outcome)) return { id: existing.id, attempt: existing.attempt };
      const used = this.db.prepare('SELECT COUNT(*) AS count FROM ai_usage_attempts WHERE owner_id = ? AND feature = ? AND local_date = ?').get(input.ownerId, input.feature, input.localDate) as { count: number };
      if (used.count >= ATTEMPT_LIMITS[input.feature]) throw new AiUsageLimitError();
      const previous = this.db.prepare(`SELECT COALESCE(MAX(attempt), 0) AS attempt FROM ai_usage_attempts
        WHERE owner_id = ? AND feature = ? AND logical_request = ?`).get(input.ownerId, input.feature, input.logicalRequest) as { attempt: number };
      const id = randomUUID();
      this.db.prepare(`INSERT INTO ai_usage_attempts
        (id, owner_id, feature, logical_request, attempt, local_date, timezone, created_at, model, service_tier, prompt_version, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'reserved')`).run(id, input.ownerId, input.feature, input.logicalRequest, previous.attempt + 1, input.localDate, input.timezone, this.clock().toISOString(), input.model, input.promptVersion);
      return { id, attempt: previous.attempt + 1 };
    })();
  }

  markRunning(id: string) { this.db.prepare("UPDATE ai_usage_attempts SET outcome = 'running' WHERE id = ? AND outcome = 'reserved'").run(id); }

  record(id: string, values: AiUsageValues) {
    this.db.prepare(`UPDATE ai_usage_attempts SET outcome = ?, duration_ms = ?, input_tokens = ?, cached_read_tokens = ?,
      cache_write_tokens = ?, output_tokens = ?, reasoning_tokens = ?, provider_request_id = ? WHERE id = ?`).run(
      values.outcome, values.durationMs ?? null, values.inputTokens ?? null, values.cachedReadTokens ?? null,
      values.cacheWriteTokens ?? null, values.outputTokens ?? null, values.reasoningTokens ?? null, values.providerRequestId ?? null, id,
    );
  }

  attempts(ownerId: string, localDate: string, feature: AiUsageFeature) {
    return this.db.prepare(`SELECT id, attempt, model, prompt_version as promptVersion, outcome, duration_ms as durationMs,
      input_tokens as inputTokens, cached_read_tokens as cachedReadTokens, cache_write_tokens as cacheWriteTokens,
      output_tokens as outputTokens, reasoning_tokens as reasoningTokens, provider_request_id as providerRequestId
      FROM ai_usage_attempts WHERE owner_id = ? AND local_date = ? AND feature = ? ORDER BY attempt`).all(ownerId, localDate, feature);
  }
}
