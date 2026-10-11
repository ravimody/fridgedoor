import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { knowledgeMaintenanceOutputSchema, knowledgeProposalSchema, type KnowledgeProposal } from '@fridgedoor/contracts';
import { decryptJson, encryptJson, type Envelope } from '../crypto.js';
import { KnowledgeRepository, type KnowledgeActor, type KnowledgeFact } from '../repos/knowledge.js';
import { AiUsageLedger, AiUsageLimitError } from './ai-usage.js';
import { KNOWLEDGE_MAINTENANCE_PROMPT_VERSION, type KnowledgeMaintenanceProvider } from '../ai/knowledge-maintenance.js';
import { lazy, type Lazy } from '../llm/hub.js';

type Clock = () => Date;
type ProposalRow = { id: string; owner_id: string; operation: KnowledgeProposal['operation']; target_keys_json: string; base_revisions_json: string; encrypted_proposed_value: string | null; encrypted_provenance_refs: string; reason: string; dedupe_key: string; status: KnowledgeProposal['status']; created_at: string; updated_at: string; expires_at: string };
export type MaintenanceEvidence = { ref: string; summary?: string };

export class KnowledgeMaintenanceService {
  private readonly repo: KnowledgeRepository;
  private readonly usage: AiUsageLedger;
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly providerSource: Lazy<KnowledgeMaintenanceProvider | undefined>, private readonly model: Lazy<string> = 'unconfigured', private readonly clock: Clock = () => new Date()) { this.repo = new KnowledgeRepository(db, key, clock); this.usage = new AiUsageLedger(db, clock); }
  private member(actor: KnowledgeActor) { const row = this.db.prepare('SELECT timezone FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId) as { timezone: string } | undefined; if (!row) throw new Error('NOT_FOUND'); return row; }
  private encode(value: unknown, context: string) { return JSON.stringify(encryptJson(value, this.key, context)); }
  private decode<T>(value: string, context: string) { return decryptJson<T>(JSON.parse(value) as Envelope, this.key, context); }
  list(actor: KnowledgeActor) {
    this.member(actor); const now = this.clock().toISOString(); this.db.prepare("UPDATE knowledge_proposals SET status = 'expired', updated_at = ? WHERE owner_id = ? AND status = 'pending' AND expires_at <= ?").run(now, actor.memberId, now);
    return (this.db.prepare("SELECT * FROM knowledge_proposals WHERE owner_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC").all(actor.memberId, now) as ProposalRow[]).map((row) => this.view(row));
  }
  async maintain(actor: KnowledgeActor, logicalRequest: string, evidence: MaintenanceEvidence[] = [], expected?: { localDate: string; timezone: string; consentRevision: number }) {
    const member = this.member(actor); const localDate = DateTime.fromJSDate(this.clock()).setZone(member.timezone).toISODate()!; let archived = 0; let deduplicated = 0;
    if (expected) {
      const settings = this.db.prepare('SELECT enabled, consent_version, revision FROM daily_ai_settings WHERE member_id = ?').get(actor.memberId) as { enabled: number; consent_version: string | null; revision: number } | undefined;
      if (!settings?.enabled || settings.consent_version !== 'daily-assistant-v1' || settings.revision !== expected.consentRevision || member.timezone !== expected.timezone || localDate !== expected.localDate) return { archived, deduplicated, proposals: [] as KnowledgeProposal[] };
    }
    const facts = this.repo.list(actor);
    for (const fact of facts) if (fact.confirmation === 'confirmed' && fact.validUntil && fact.validUntil <= localDate) { try { this.repo.archive(actor, fact.key, fact.revision, 'maintenance-expiry'); archived++; } catch { /* A concurrent owner edit wins. */ } }
    const remaining = this.repo.list(actor); const seen = new Map<string, KnowledgeFact>();
    for (const fact of remaining) {
      const identity = `${normalise(fact.key)}\u0000${normalise(fact.value)}\u0000${fact.provenance}\u0000${fact.confirmation}\u0000${fact.validFrom ?? ''}\u0000${fact.validUntil ?? ''}\u0000${fact.relationKey ?? ''}`; const prior = seen.get(identity);
      if (!prior) seen.set(identity, fact);
      else { try { this.repo.archive(actor, fact.key, fact.revision, 'maintenance-duplicate'); deduplicated++; } catch { /* A concurrent owner edit wins. */ } }
    }
    const currentFacts = this.repo.list(actor);
    const provider = lazy(this.providerSource);
    if (!provider || evidence.length === 0) return { archived, deduplicated, proposals: [] as KnowledgeProposal[] };
    const digest = createHash('sha256').update(JSON.stringify({ facts: currentFacts, evidence })).digest('hex');
    if (this.db.prepare('SELECT 1 FROM knowledge_maintenance_runs WHERE owner_id = ? AND local_date = ? AND input_digest = ?').get(actor.memberId, localDate, digest)) return { archived, deduplicated, proposals: [] as KnowledgeProposal[] };
    let reservation;
    try { reservation = this.usage.reserve({ ownerId: actor.memberId, feature: 'daily_maintenance', logicalRequest, localDate, timezone: member.timezone, model: lazy(this.model), promptVersion: KNOWLEDGE_MAINTENANCE_PROMPT_VERSION }); } catch (error) { if (error instanceof AiUsageLimitError) return { archived, deduplicated, proposals: [] as KnowledgeProposal[] }; throw error; }
    this.usage.markRunning(reservation.id); const started = this.clock().getTime(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await provider.generate({ facts: this.repo.list(actor), evidence }, controller.signal);
      this.usage.record(reservation.id, { ...response.usage, outcome: 'response_received', durationMs: this.clock().getTime() - started });
      const parsed = knowledgeMaintenanceOutputSchema.safeParse(response.result);
      if (!parsed.success) { this.usage.record(reservation.id, { ...response.usage, outcome: 'rejected', durationMs: this.clock().getTime() - started }); return { archived, deduplicated, proposals: [] as KnowledgeProposal[] }; }
      const proposals = parsed.data.proposals.filter((proposal) => proposal.provenanceRefs.length > 0 && proposal.provenanceRefs.every((ref) => evidence.some((item) => item.ref === ref))).slice(0, 5).map((proposal) => { try { return this.createProposal(actor, proposal, evidence); } catch { return undefined; } }).filter((proposal): proposal is KnowledgeProposal => Boolean(proposal));
      this.db.prepare('INSERT OR IGNORE INTO knowledge_maintenance_runs (owner_id, local_date, input_digest, completed_at) VALUES (?, ?, ?, ?)').run(actor.memberId, localDate, digest, this.clock().toISOString());
      return { archived, deduplicated, proposals };
    } catch { this.usage.record(reservation.id, { outcome: controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_FAILED', durationMs: this.clock().getTime() - started }); return { archived, deduplicated, proposals: [] as KnowledgeProposal[] }; }
    finally { clearTimeout(timer); }
  }
  accept(actor: KnowledgeActor, id: string) {
    const row = this.row(actor, id); if (row.status !== 'pending') return this.view(row);
    const keys = JSON.parse(row.target_keys_json) as string[]; const revisions = JSON.parse(row.base_revisions_json) as number[]; const refs = this.decode<string[]>(row.encrypted_provenance_refs, `knowledge-proposal:${id}:sources`); const value = row.encrypted_proposed_value ? this.decode<string>(row.encrypted_proposed_value, `knowledge-proposal:${id}:value`) : null;
    if (row.operation === 'merge' || keys.length !== 1 || (row.operation !== 'archive' && value === null) || (row.operation === 'archive' && value !== null)) throw new Error('INVALID_PROPOSAL');
    const current = this.repo.get(actor, keys[0]!); const expected = revisions[0] ?? 0;
    if (row.operation === 'archive') this.repo.archive(actor, keys[0]!, expected, 'accepted-maintenance', refs);
    else if (!current && this.repo.isForgotten(actor, keys[0]!)) throw new Error('FORGOTTEN_FACT');
    else {
      if (value === null) throw new Error('INVALID_PROPOSAL');
      this.repo.set(actor, { key: keys[0]!, value, expectedRevision: expected, provenance: 'source', confirmation: 'confirmed', sourceManifest: refs, reason: 'accepted-maintenance', origin: 'user' });
    }
    this.db.prepare("UPDATE knowledge_proposals SET status = 'applied', updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'pending'").run(this.clock().toISOString(), id, actor.memberId);
    return { applied: true, key: keys[0], revision: (current?.revision ?? 0) + 1 };
  }
  dismiss(actor: KnowledgeActor, id: string) { const row = this.row(actor, id); if (row.status === 'pending') this.db.prepare("UPDATE knowledge_proposals SET status = 'dismissed', updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'pending'").run(this.clock().toISOString(), id, actor.memberId); return { dismissed: true }; }
  private row(actor: KnowledgeActor, id: string) { this.member(actor); const row = this.db.prepare('SELECT * FROM knowledge_proposals WHERE id = ? AND owner_id = ?').get(id, actor.memberId) as ProposalRow | undefined; if (!row) throw new Error('NOT_FOUND'); return row; }
  private createProposal(actor: KnowledgeActor, proposal: { operation: KnowledgeProposal['operation']; targetKeys: string[]; baseRevisions: number[]; proposedValue: string | null; provenanceRefs: string[]; reason: string }, evidence: MaintenanceEvidence[]) {
    this.repo.list(actor); if (proposal.targetKeys.some((key) => key.length > 80 || !/^[\w .-]+$/.test(key)) || proposal.proposedValue && proposal.proposedValue.length > 500 || proposal.baseRevisions.length !== proposal.targetKeys.length || proposal.provenanceRefs.some((ref) => !evidence.some((item) => item.ref === ref))) throw new Error('INVALID_PROPOSAL');
    const dedupeKey = `${proposal.operation}:${proposal.targetKeys.join(',')}:${proposal.baseRevisions.join(',')}:${proposal.provenanceRefs.join(',')}:${normalise(proposal.proposedValue ?? '')}`; const existing = this.db.prepare('SELECT * FROM knowledge_proposals WHERE owner_id = ? AND dedupe_key = ?').get(actor.memberId, dedupeKey) as ProposalRow | undefined; if (existing) return existing.status === 'pending' ? this.view(existing) : undefined;
    if ((this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_proposals WHERE owner_id = ? AND status = 'pending'").get(actor.memberId) as { count: number }).count >= 10) throw new Error('PROPOSAL_LIMIT');
    const id = randomUUID(); const now = this.clock().toISOString(); this.db.prepare(`INSERT INTO knowledge_proposals (id, owner_id, operation, target_keys_json, base_revisions_json, encrypted_proposed_value, encrypted_provenance_refs, reason, dedupe_key, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, actor.memberId, proposal.operation, JSON.stringify(proposal.targetKeys), JSON.stringify(proposal.baseRevisions), proposal.proposedValue === null ? null : this.encode(proposal.proposedValue, `knowledge-proposal:${id}:value`), this.encode(proposal.provenanceRefs, `knowledge-proposal:${id}:sources`), proposal.reason, dedupeKey, now, now, new Date(this.clock().getTime() + 30 * 86400000).toISOString()); return this.view(this.row(actor, id));
  }
  private view(row: ProposalRow): KnowledgeProposal { return knowledgeProposalSchema.parse({ id: row.id, operation: row.operation, targetKeys: JSON.parse(row.target_keys_json), baseRevisions: JSON.parse(row.base_revisions_json), proposedValue: row.encrypted_proposed_value ? this.decode<string>(row.encrypted_proposed_value, `knowledge-proposal:${row.id}:value`) : null, provenanceRefs: this.decode<string[]>(row.encrypted_provenance_refs, `knowledge-proposal:${row.id}:sources`), reason: row.reason, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at }); }
}
function normalise(value: string) { return value.trim().toLocaleLowerCase().replace(/\s+/g, ' '); }
