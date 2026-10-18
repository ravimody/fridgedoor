import type { EmailGateCheckpoint, EmailGateStore } from '../providers/ai-contracts.js';
import { isInboxMessage } from '../sync/gmail-scope.js';
import { nextMorningReview } from '../services/plan-attention.js';
import { BackgroundAiService, BACKGROUND_AI_CONSENT } from '../services/background-ai.js';
import { JobQueue } from '../jobs/queue.js';
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { decryptJson, encryptJson } from '../crypto.js';
import type { JobRecord } from '../jobs/queue.js';
import type { AiProvider, ExtractionPacket, ExtractionResult } from '../providers/ai.js';
import { extractionResultSchema } from '../providers/ai.js';
import { POLICY_VERSION, PROMPT_VERSION, projectPolicy, validateEvidence } from './policy.js';
import type { SourceEvidence } from '../repos/sources.js';
import { PersonalRelevanceRepository } from '../repos/personal-relevance.js';
import { KnowledgeRepository } from '../repos/knowledge.js';
import { lazy, type Lazy } from '../llm/hub.js';

type Context = { consentRevision: number; connectionGeneration: number; sourceVersionId: string; contentDigest: string; encryptedEvidence: string; expiresAt: string; connectionId: string; memberId: string; householdId: string; displayName: string; timezone: string; generation: number; status: string; policy: { excludedSenders: string[]; excludedLabels: string[]; genericAppointmentOptIn: boolean } };
export type ExtractionRunResult = { state: 'complete' } | { state: 'retry'; delayMs?: number; retryKind: 'transient' | 'capacity' };
export type ExtractionSuccess = { sourceVersionId: string; ownerId: string; householdId: string; result: ExtractionResult };

export class ExtractionService {
  /** `model` may be a getter: it is read once per job, and undefined (AI turned off) leaves jobs waiting. */
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly provider: AiProvider, private readonly modelSource: Lazy<string | undefined>, private readonly clock: () => Date = () => new Date(), private readonly onSuccess?: (input: ExtractionSuccess) => void) {}
  ready() { return Boolean(lazy(this.modelSource)); }
  private context(job: JobRecord): Context | undefined {
    const versionId = job.payload.sourceVersionId; if (!versionId || job.payload.generation === undefined) throw new Error('JOB_PAYLOAD_INVALID');
    const row = this.db.prepare(`SELECT sv.id as sourceVersionId, sv.content_digest as contentDigest, sv.encrypted_evidence as encryptedEvidence, sv.expires_at as expiresAt,
      si.connection_id as connectionId, si.owner_id as memberId, m.household_id as householdId, m.display_name as displayName, m.timezone, si.generation, gc.generation AS connectionGeneration, gc.status, ba.revision AS consentRevision, sp.excluded_senders_json, sp.excluded_labels_json, sp.generic_appointment_opt_in
      FROM source_versions sv JOIN source_items si ON si.id = sv.source_id JOIN members m ON m.id = si.owner_id JOIN google_connections gc ON gc.id = si.connection_id AND gc.member_id = si.owner_id
      JOIN background_ai_settings ba ON ba.member_id = si.owner_id AND ba.enabled = 1 AND ba.consent_version = ?
      LEFT JOIN source_policies sp ON sp.member_id = si.owner_id WHERE sv.id = ? AND m.active = 1 AND si.current_version_id = sv.id AND si.state = 'available' AND sv.availability = 'available' AND sv.expires_at > ?`).get(BACKGROUND_AI_CONSENT, versionId, this.clock().toISOString()) as (Context & { excluded_senders_json?: string; excluded_labels_json?: string; generic_appointment_opt_in?: number }) | undefined;
    if (!row || row.status !== 'active' || row.generation !== job.payload.generation || row.connectionGeneration !== job.payload.generation) return undefined;
    return { ...row, policy: { excludedSenders: row.excluded_senders_json ? JSON.parse(row.excluded_senders_json) as string[] : [], excludedLabels: row.excluded_labels_json ? JSON.parse(row.excluded_labels_json) as string[] : [], genericAppointmentOptIn: Boolean(row.generic_appointment_opt_in) } };
  }
  private packet(context: Context): { packet: ExtractionPacket; source: SourceEvidence } {
    const source = decryptJson<SourceEvidence>(JSON.parse(context.encryptedEvidence), this.key, `source-version:${context.sourceVersionId}`);
    const text = source.text.slice(0, 24_000);
    const local = DateTime.fromJSDate(this.clock()).setZone(context.timezone); const startDate = local.toISODate()!; const endDate = local.plus({ days: 8 }).toISODate()!;
    const knowledge = new KnowledgeRepository(this.db, this.key, this.clock).context({ memberId: context.memberId, householdId: context.householdId }, startDate, endDate).slice(0, 50).map((fact) => ({ key: fact.key.slice(0, 80), value: fact.value.slice(0, 300), revision: fact.revision, provenance: fact.provenance, confirmation: fact.confirmation, validity: fact.validity, validFrom: fact.validFrom, validUntil: fact.validUntil }));
    return { source, packet: { schemaVersion: 'extract-v1', referenceTime: this.clock().toISOString(), nextMorningReview: nextMorningReview(this.db,context.memberId,context.timezone,this.clock()), sourceVersionId: context.sourceVersionId, ...(source.internalDate ? { sourceTime: source.internalDate } : {}), timezone: context.timezone, ownerLabel: context.displayName, allowedParticipants: [context.displayName], allowedCategories: ['school', 'travel', 'appointment', 'optional', 'work', 'medical', 'other'], text, truncated: source.text.length > text.length || source.attachmentsIncomplete, knowledge, ...(source.subject ? {subject: source.subject} : {}), ...(source.sender ? {sender: source.sender} : {}), personalPreferences: new PersonalRelevanceRepository(this.db,this.key,this.clock).context({memberId:context.memberId,householdId:context.householdId}), ...(source.media?.length ? { media: source.media } : {}) } };
  }
  async run(job: JobRecord): Promise<ExtractionRunResult> {
    const context = this.context(job); if (!context) return { state: 'complete' };
    const model = lazy(this.modelSource); if (!model) return { state: 'retry', retryKind: 'capacity', delayMs: 300_000 };
    const prior = this.db.prepare("SELECT 1 FROM extractions WHERE source_version_id = ? AND model = ? AND policy_version = ? AND state = 'succeeded' LIMIT 1").get(context.sourceVersionId, model, POLICY_VERSION);
    if (prior) return { state: 'complete' };
    const existing = this.db.prepare('SELECT id, provider, state, encrypted_result FROM extractions WHERE source_version_id = ? AND model = ? AND prompt_version = ? AND policy_version = ? ORDER BY created_at DESC LIMIT 1').get(context.sourceVersionId, model, PROMPT_VERSION, POLICY_VERSION) as { id: string; provider: string; state: string; encrypted_result: string | null } | undefined;
    if (existing?.state === 'succeeded') return { state: 'complete' };
    const { packet, source } = this.packet(context);
    if (!isInboxMessage(source)) return { state: 'complete' };
    const sender = (source.sender?.match(/<([^>]+)>/)?.[1] ?? source.sender ?? '').trim().toLowerCase();
    if (context.policy.excludedSenders.some((value) => value.trim().toLowerCase() === sender) || source.labels.some((label) => context.policy.excludedLabels.includes(label))) return { state: 'complete' };
    if (!new JobQueue(this.db, this.clock).heartbeat(job)) return { state: 'complete' };
    const reservation = this.provider.managesReservations ? 'reserved' : new BackgroundAiService(this.db, true, this.clock).reserve(context.memberId, context.sourceVersionId, model);
    if (reservation === 'capacity') return { state: 'retry', retryKind: 'capacity', delayMs: 300_000 };
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 110_000);
    const heartbeat = setInterval(() => { if (!new JobQueue(this.db,this.clock).heartbeat(job)) controller.abort(); }, 20_000);
    try {
      if (reservation === 'exhausted') throw new Error('AI_RETRY_LIMIT');
      const checkpointScope = JSON.stringify([context.sourceVersionId,model,PROMPT_VERSION,POLICY_VERSION,context.consentRevision]);
      const checkpoints: EmailGateStore = {
        load: (cacheKey) => {
          const row = this.db.prepare('SELECT encrypted_checkpoint FROM email_gate_checkpoints WHERE source_version_id=? AND scope=? AND cache_key=?').get(context.sourceVersionId,checkpointScope,cacheKey) as {encrypted_checkpoint:string}|undefined;
          return row ? decryptJson<EmailGateCheckpoint>(JSON.parse(row.encrypted_checkpoint),this.key,checkpointScope) : undefined;
        },
        save: (cacheKey,value) => {
          const current=this.context(job);
          if(!current || current.consentRevision!==context.consentRevision || !new JobQueue(this.db,this.clock).heartbeat(job)) throw new Error('AI_CONTEXT_CHANGED');
          this.db.prepare('INSERT INTO email_gate_checkpoints (source_version_id,scope,cache_key,encrypted_checkpoint) VALUES (?,?,?,?) ON CONFLICT(source_version_id) DO UPDATE SET scope=excluded.scope,cache_key=excluded.cache_key,encrypted_checkpoint=excluded.encrypted_checkpoint').run(context.sourceVersionId,checkpointScope,cacheKey,JSON.stringify(encryptJson(value,this.key,checkpointScope)));
        },
      };
      const response = await this.provider.extract(packet, controller.signal, (model) => {
        const current = this.context(job);
        if (!current || current.consentRevision !== context.consentRevision || !new JobQueue(this.db,this.clock).heartbeat(job)) throw new Error('AI_CONTEXT_CHANGED');
        const reviewReservation = new BackgroundAiService(this.db,true,this.clock).reserve(context.memberId,context.sourceVersionId,model);
        if(reviewReservation === 'capacity') throw new Error('AI_REVIEW_CAPACITY');
        if(reviewReservation === 'exhausted') throw new Error('AI_RETRY_LIMIT');
      }, checkpoints); if (response.model !== model) throw new Error('AI_MODEL_MISMATCH'); const raw = extractionResultSchema.parse(response.result); validateEvidence(raw, packet);
      this.db.transaction(() => {
        const current = this.context(job);
        if (!current || current.consentRevision !== context.consentRevision || !new JobQueue(this.db, this.clock).heartbeat(job)) return;
        const result = projectPolicy(raw, current.policy, { sender, labels: source.labels, incomplete: packet.truncated });
        const id = existing?.provider === response.provider ? existing.id : randomBytes(16).toString('hex'); const now = this.clock().toISOString(); this.db.prepare(`INSERT INTO extractions (id, source_version_id, provider, model, prompt_version, policy_version, input_digest, state, encrypted_result, usage_json, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?) ON CONFLICT(source_version_id, provider, model, prompt_version, policy_version) DO UPDATE SET state = 'succeeded', encrypted_result = excluded.encrypted_result, usage_json = excluded.usage_json, error_code = NULL, expires_at = excluded.expires_at, updated_at = excluded.updated_at`).run(id, context.sourceVersionId, response.provider, response.model, PROMPT_VERSION, POLICY_VERSION, context.contentDigest, JSON.stringify(encryptJson(result, this.key, `extraction:${id}`)), JSON.stringify(response.usage), context.expiresAt, now, now); this.onSuccess?.({ sourceVersionId: context.sourceVersionId, ownerId: context.memberId, householdId: context.householdId, result });
      })(); return { state: 'complete' };
    } catch (error) {
      const current = this.context(job);
      if (!current || current.consentRevision !== context.consentRevision || !new JobQueue(this.db, this.clock).heartbeat(job)) return { state: 'complete' };
      const code = error instanceof Error && /^AI_[A-Z_]+$/.test(error.message) ? error.message : 'AI_FAILED';
      if(code === 'AI_REVIEW_CAPACITY') return {state:'retry',retryKind:'capacity',delayMs:300_000};
      if (code === 'AI_RETRYABLE' || (error instanceof Error && error.name === 'AbortError')) return { state: 'retry', retryKind: 'transient', delayMs: 30_000 };
      const id = existing?.provider === 'unknown' ? existing.id : randomBytes(16).toString('hex'); const now = this.clock().toISOString(); this.db.prepare(`INSERT INTO extractions (id, source_version_id, provider, model, prompt_version, policy_version, input_digest, state, encrypted_result, usage_json, error_code, expires_at, created_at, updated_at)
        VALUES (?, ?, 'unknown', ?, ?, ?, ?, 'failed', NULL, '{}', ?, ?, ?, ?) ON CONFLICT(source_version_id, provider, model, prompt_version, policy_version) DO UPDATE SET state = 'failed', encrypted_result = NULL, error_code = excluded.error_code, updated_at = excluded.updated_at`).run(id, context.sourceVersionId, model, PROMPT_VERSION, POLICY_VERSION, context.contentDigest, code, context.expiresAt, now, now); return { state: 'complete' };
    } finally { clearTimeout(timeout); clearInterval(heartbeat); }
  }
}
