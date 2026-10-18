import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { planFactsSchema, unresolvedTimeSchema, type PlanFacts, type PlanSummary } from '@fridgedoor/contracts';
import { decryptJson, encryptJson, type Envelope } from '../crypto.js';
import type { SourceEvidence } from './sources.js';
import { dateKey, materialFingerprint, matchPlan, type MatchRow } from '../domain/matching.js';

type Clock = () => Date;
type PlanRow = { id: string; household_id: string; visibility: 'shared'|'private'; owner_id: string|null; status: PlanSummary['status']; current_version_id: string|null; pending_version_id: string|null; dismissal_fingerprint: string|null; possible_duplicate_plan_id: string|null; revision: number; kept_at: string|null; created_at: string; updated_at: string };
type VersionRow = { id: string; plan_id: string; sequence: number; visibility: 'shared'|'private'; owner_id: string|null; fact_json: string|null; encrypted_fact_json: string|null; material_fingerprint: string; previous_version_id: string|null; origin: 'extraction'|'user'; actor_id: string|null; change_kind: 'new'|'update'|'cancel'; created_at: string };
const parseJson = <T>(value: string) => JSON.parse(value) as T;
const titled = (visibility: 'shared' | 'private', title: string) => visibility === 'shared' ? { title } : {};

export class PlanRepository {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: Clock = () => new Date()) {}

  private plan(planId: string, memberId: string) {
    const row = this.db.prepare(`SELECT p.* FROM plans p JOIN members m ON m.household_id = p.household_id
      WHERE p.id = ? AND m.id = ? AND m.active=1 AND (p.visibility = 'shared' OR p.owner_id = ?)`).get(planId, memberId, memberId) as PlanRow | undefined;
    if (!row) throw new Error('NOT_FOUND');
    return row;
  }
  private version(id: string) { return this.db.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id) as VersionRow | undefined; }
  private facts(version: VersionRow, memberId: string): PlanFacts {
    if (version.visibility === 'shared') return planFactsSchema.parse(parseJson<unknown>(version.fact_json!));
    if (version.owner_id !== memberId || !version.encrypted_fact_json) throw new Error('NOT_FOUND');
    return planFactsSchema.parse(decryptJson<PlanFacts>(parseJson<Envelope>(version.encrypted_fact_json), this.key, `plan-version:${version.id}`));
  }
  private versionFor(row: PlanRow, memberId: string) { const id = row.pending_version_id ?? row.current_version_id; if (!id) throw new Error('PLAN_VERSION_MISSING'); const version = this.version(id); if (!version) throw new Error('PLAN_VERSION_MISSING'); return { version, facts: this.facts(version, memberId) }; }
  private sourceSummary(planId: string) { const row = this.db.prepare('SELECT COUNT(*) AS count, SUM(CASE WHEN sv.availability = \'available\' THEN 1 ELSE 0 END) AS available FROM plan_sources ps JOIN source_versions sv ON sv.id = ps.source_version_id WHERE ps.plan_id = ?').get(planId) as { count: number; available: number|null }; return { kind: row.count ? 'email' : 'manual', count: row.count, available: row.count > 0 && row.available === row.count }; }
  private summary(row: PlanRow, memberId: string): PlanSummary {
    const currentVersion = row.current_version_id ? this.version(row.current_version_id) : undefined; if (!currentVersion) throw new Error('PLAN_VERSION_MISSING'); const currentFacts = this.facts(currentVersion, memberId);
    // Older assistant versions retained a partial start in this exact notes line.
    // Recover it only for display; never infer an end or authorize calendar writes.
    if (!currentFacts.time && currentVersion.origin === 'user') {
      const startHint = currentFacts.notes?.match(/^Known start: ([^;\n]+); end needs review\.$/m)?.[1];
      const partial = unresolvedTimeSchema.safeParse({ kind: 'unresolved', startHint, missing: ['end'] });
      if (startHint && partial.success) currentFacts.time = partial.data;
    }
    const pendingVersion = row.pending_version_id ? this.version(row.pending_version_id) : undefined; const pendingFacts = pendingVersion ? this.facts(pendingVersion, memberId) : undefined;
    return { savedInPlanner: Boolean(row.kept_at), calendarAction: (this.db.prepare("SELECT id as actionId, state, kind FROM calendar_actions WHERE plan_id = ? ORDER BY rowid DESC LIMIT 1").get(row.id) as { actionId: string; state: string; kind: 'create' | 'update' | 'cancel' } | undefined) ?? null, id: row.id, revision: row.revision, visibility: row.visibility, status: row.status, facts: currentFacts, changeKind: pendingVersion?.change_kind ?? currentVersion.change_kind, createdAt: row.created_at, updatedAt: row.updated_at, sourceSummary: this.sourceSummary(row.id), possibleDuplicate: Boolean(row.possible_duplicate_plan_id), ...(pendingFacts ? { pendingFacts } : {}) };
  }
  // History is shown to everyone who can see the plan, and a private plan can be shared later,
  // so entries made while it is private never record its title.
  private addHistory(planId: string, householdId: string, actorId: string|null, type: string, payload: Record<string, unknown>, privateSourceId: string|null = null) { this.db.prepare('INSERT INTO history_entries (id, household_id, plan_id, actor_id, type, safe_payload_json, private_source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomBytes(16).toString('hex'), householdId, planId, actorId, type, JSON.stringify(payload), privateSourceId, this.clock().toISOString()); }
  private createVersion(input: { planId: string; visibility: 'shared'|'private'; ownerId: string|null; facts: PlanFacts; previousVersionId: string|null; origin: 'extraction'|'user'; actorId: string|null; changeKind: 'new'|'update'|'cancel' }) {
    const id = randomBytes(16).toString('hex'); const sequence = Number((this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM plan_versions WHERE plan_id = ?').get(input.planId) as { value: number }).value) + 1; const fingerprint = materialFingerprint(input.facts); const privatePayload = input.visibility === 'private' ? JSON.stringify(encryptJson(input.facts, this.key, `plan-version:${id}`)) : null; const sharedPayload = input.visibility === 'shared' ? JSON.stringify(input.facts) : null;
    this.db.prepare(`INSERT INTO plan_versions (id, plan_id, sequence, visibility, owner_id, fact_json, encrypted_fact_json, material_fingerprint, previous_version_id, origin, actor_id, change_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.planId, sequence, input.visibility, input.ownerId, sharedPayload, privatePayload, fingerprint, input.previousVersionId, input.origin, input.actorId, input.changeKind, this.clock().toISOString());
    return { id, fingerprint };
  }
  private rowsForMatching(householdId: string, ownerId: string, visibility: 'shared'|'private') {
    return this.db.prepare(`SELECT p.id, p.visibility, p.owner_id as ownerId, COALESCE(p.pending_version_id, p.current_version_id) as versionId, pv.fact_json as factJson, pv.encrypted_fact_json as encryptedFactJson, pv.material_fingerprint as materialFingerprint
      FROM plans p JOIN plan_versions pv ON pv.id = COALESCE(p.pending_version_id, p.current_version_id) WHERE p.household_id = ? AND p.visibility = ? AND (p.visibility = 'shared' OR p.owner_id = ?) AND p.status != 'archived'`).all(householdId, visibility, ownerId).map((row) => { const item = row as { id: string; visibility: 'shared'|'private'; ownerId: string|null; versionId: string; factJson: string|null; encryptedFactJson: string|null; materialFingerprint: string }; let facts: PlanFacts; if (item.visibility === 'shared') facts = planFactsSchema.parse(parseJson<unknown>(item.factJson!)); else facts = decryptJson<PlanFacts>(parseJson<Envelope>(item.encryptedFactJson!), this.key, `plan-version:${item.versionId}`); return { id: item.id, visibility: item.visibility, ownerId: item.ownerId, title: facts.title, materialFingerprint: item.materialFingerprint, dateKey: dateKey(facts) } satisfies MatchRow; });
  }

  upsertExtraction(input: { id: string; sourceVersionId: string; ownerId: string; householdId: string; visibility: 'shared'|'private'; facts: PlanFacts; relation: 'new'|'update'|'cancel'; evidenceRole: string }) {
    const result = planFactsSchema.parse(input.facts); const tx = this.db.transaction(() => {
      const rows = this.rowsForMatching(input.householdId, input.ownerId, input.visibility); const match = matchPlan(result, input.visibility, input.visibility === 'private' ? input.ownerId : null, rows);
      const source = this.db.prepare('SELECT owner_id as ownerId FROM source_items WHERE id = (SELECT source_id FROM source_versions WHERE id = ?) AND owner_id = ?').get(input.sourceVersionId, input.ownerId) as { ownerId: string } | undefined; if (!source) throw new Error('SOURCE_NOT_FOUND');
      let plan: PlanRow | undefined;
      if (match.kind === 'exact' && match.planId) { plan = this.plan(match.planId, input.ownerId); this.db.prepare('INSERT OR IGNORE INTO plan_sources (plan_id, source_version_id, owner_id, evidence_role) VALUES (?, ?, ?, ?)').run(plan.id, input.sourceVersionId, input.ownerId, input.evidenceRole); return plan.id; }
      if (match.kind === 'possible' && match.planId && input.relation !== 'new') { plan = this.plan(match.planId, input.ownerId); const current = this.versionFor(plan, input.ownerId); const version = this.createVersion({ planId: plan.id, visibility: input.visibility, ownerId: input.visibility === 'private' ? input.ownerId : null, facts: result, previousVersionId: current.version.id, origin: 'extraction', actorId: null, changeKind: input.relation }); this.db.prepare('UPDATE plans SET pending_version_id = ?, status = \'proposed\', revision = revision + 1, updated_at = ? WHERE id = ?').run(version.id, this.clock().toISOString(), plan.id); this.db.prepare('INSERT OR IGNORE INTO plan_sources (plan_id, source_version_id, owner_id, evidence_role) VALUES (?, ?, ?, ?)').run(plan.id, input.sourceVersionId, input.ownerId, input.evidenceRole); this.addHistory(plan.id, plan.household_id, null, 'suggestion_updated', { changeKind: input.relation, ...titled(input.visibility, result.title) }, input.visibility === 'private' ? input.sourceVersionId : null); return plan.id; }
      const id = randomBytes(16).toString('hex'); const now = this.clock().toISOString(); const duplicate = match.kind === 'possible' ? match.planId ?? null : null; this.db.prepare('INSERT INTO plans (id, household_id, visibility, owner_id, status, revision, possible_duplicate_plan_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(id, input.householdId, input.visibility, input.visibility === 'private' ? input.ownerId : null, result.unresolvedFields.length ? 'needs_details' : 'proposed', duplicate, now, now); const version = this.createVersion({ planId: id, visibility: input.visibility, ownerId: input.visibility === 'private' ? input.ownerId : null, facts: result, previousVersionId: null, origin: 'extraction', actorId: null, changeKind: input.relation }); this.db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run(version.id, id); this.db.prepare('INSERT INTO plan_sources (plan_id, source_version_id, owner_id, evidence_role) VALUES (?, ?, ?, ?)').run(id, input.sourceVersionId, input.ownerId, input.evidenceRole); this.addHistory(id, input.householdId, null, 'suggestion_created', { visibility: input.visibility, ...titled(input.visibility, result.title) }, input.visibility === 'private' ? input.sourceVersionId : null); return id;
    }); return tx();
  }

  createPrivate(actor: { memberId: string; householdId: string }, facts: PlanFacts) {
    const parsed = planFactsSchema.parse(facts);
    if (!this.db.prepare('SELECT 1 FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId)) throw new Error('NOT_FOUND');
    const id = randomBytes(16).toString('hex'); const now = this.clock().toISOString();
    this.db.prepare('INSERT INTO plans (id, household_id, visibility, owner_id, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(id, actor.householdId, 'private', actor.memberId, parsed.unresolvedFields.length ? 'needs_details' : 'proposed', now, now);
    const version = this.createVersion({ planId: id, visibility: 'private', ownerId: actor.memberId, facts: parsed, previousVersionId: null, origin: 'user', actorId: actor.memberId, changeKind: 'new' });
    this.db.prepare('UPDATE plans SET current_version_id = ? WHERE id = ?').run(version.id, id);
    return id;
  }

  list(memberId: string, status?: PlanSummary['status']) { const rows = this.db.prepare(`SELECT p.* FROM plans p WHERE (p.household_id = (SELECT household_id FROM members WHERE id = ? AND active=1) AND (p.visibility='shared' OR p.owner_id=?)) ${status ? 'AND p.status = ?' : "AND p.status NOT IN ('dismissed', 'archived')"} ORDER BY p.updated_at DESC`).all(...(status ? [memberId, memberId, status] : [memberId, memberId])) as PlanRow[]; return rows.map((row) => this.summary(row, memberId)); }
  detail(planId: string, memberId: string) { return this.summary(this.plan(planId, memberId), memberId); }
  edit(planId: string, memberId: string, expectedRevision: number, facts: PlanFacts) { const row = this.plan(planId, memberId); if (row.revision !== expectedRevision) throw new Error('STALE_REVISION'); const parsed = planFactsSchema.parse(facts); const current = this.versionFor(row, memberId); const version = this.createVersion({ planId, visibility: row.visibility, ownerId: row.visibility === 'private' ? memberId : null, facts: parsed, previousVersionId: current.version.id, origin: 'user', actorId: memberId, changeKind: 'update' }); const now = this.clock().toISOString(); if (row.status === 'accepted') this.db.prepare('UPDATE plans SET pending_version_id = ?, status = \'proposed\', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(version.id, now, planId, expectedRevision); else this.db.prepare('UPDATE plans SET current_version_id = ?, pending_version_id = NULL, status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(version.id, parsed.unresolvedFields.length ? 'needs_details' : 'proposed', now, planId, expectedRevision); this.addHistory(planId, row.household_id, memberId, 'facts_edited', { ...titled(row.visibility, parsed.title), changeKind: 'update' }); return this.detail(planId, memberId); }
  share(planId: string, memberId: string, expectedRevision: number, facts: PlanFacts) { const row = this.plan(planId, memberId); if (row.visibility !== 'private' || row.owner_id !== memberId) throw new Error('FORBIDDEN'); if (row.revision !== expectedRevision) throw new Error('STALE_REVISION'); const parsed = planFactsSchema.parse(facts); const current = this.versionFor(row, memberId); const version = this.createVersion({ planId, visibility: 'shared', ownerId: null, facts: parsed, previousVersionId: current.version.id, origin: 'user', actorId: memberId, changeKind: 'new' }); this.db.prepare("UPDATE plans SET visibility = 'shared', owner_id = NULL, current_version_id = ?, pending_version_id = NULL, status = 'proposed', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(version.id, this.clock().toISOString(), planId, expectedRevision); this.addHistory(planId, row.household_id, memberId, 'proposal_shared', { title: parsed.title }); return this.detail(planId, memberId); }
  dismiss(planId: string, memberId: string, expectedRevision: number) { const row = this.plan(planId, memberId); if (row.revision !== expectedRevision) throw new Error('STALE_REVISION'); const current = this.versionFor(row, memberId); this.db.prepare("UPDATE plans SET status = 'dismissed', pending_version_id = NULL, dismissal_fingerprint = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(current.version.material_fingerprint, this.clock().toISOString(), planId, expectedRevision); this.addHistory(planId, row.household_id, memberId, 'suggestion_dismissed', { ...titled(row.visibility, current.facts.title) }); return this.detail(planId, memberId); }
  history(planId: string, memberId: string) { const row = this.plan(planId, memberId); return this.db.prepare('SELECT h.id, h.type, COALESCE(m.display_name, \'System\') as actorLabel, h.safe_payload_json as safePayload, h.created_at as createdAt FROM history_entries h LEFT JOIN members m ON m.id = h.actor_id WHERE h.plan_id = ? ORDER BY h.created_at DESC').all(row.id).map((entry) => { const item = entry as { id: string; type: string; actorLabel: string; safePayload: string; createdAt: string }; return { id: item.id, type: item.type, actorLabel: item.actorLabel, safePayload: parseJson<Record<string, unknown>>(item.safePayload), createdAt: item.createdAt }; }); }
  evidence(planId: string, memberId: string, sourceVersionId?: string) {
    const row=this.plan(planId,memberId);
    const source=this.db.prepare(`SELECT ps.source_version_id as sourceVersionId, sv.availability, sv.expires_at, si.state, si.kind,
      si.connection_id, si.generation, gc.status as connection_status, gc.generation as connection_generation, sv.encrypted_evidence as encryptedEvidence
      FROM plan_sources ps JOIN source_versions sv ON sv.id=ps.source_version_id JOIN source_items si ON si.id=sv.source_id
      LEFT JOIN google_connections gc ON gc.id=si.connection_id AND gc.member_id=si.owner_id
      WHERE ps.plan_id=? AND ps.owner_id=? AND si.owner_id=ps.owner_id ${sourceVersionId?'AND ps.source_version_id=?':''}
      ORDER BY sv.observed_at DESC LIMIT 1`).get(...(sourceVersionId?[row.id,memberId,sourceVersionId]:[row.id,memberId])) as {sourceVersionId:string;availability:'available'|'expired'|'deleted'|'incomplete';expires_at:string;state:string;kind:string;connection_id:string|null;generation:number;connection_status:string|null;connection_generation:number|null;encryptedEvidence:string}|undefined;
    if(!source)throw new Error('NOT_FOUND');
    const availability=source.expires_at<=this.clock().toISOString() ? 'expired' as const
      : source.state!=='available' || source.connection_id && (source.connection_status!=='active' || source.connection_generation!==source.generation) ? 'deleted' as const : source.availability;
    if(availability!=='available')return {sourceVersionId:source.sourceVersionId,availability,kind:source.kind,labels:[]};
    const evidence=decryptJson<SourceEvidence>(parseJson<Envelope>(source.encryptedEvidence),this.key,`source-version:${source.sourceVersionId}`);
    return {sourceVersionId:source.sourceVersionId,availability,kind:source.kind,text:evidence.text,...(evidence.sender?{sender:evidence.sender}:{}),labels:evidence.labels};
  }
}
