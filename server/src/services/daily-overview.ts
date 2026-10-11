import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { dailyOverviewSchema, type DailyOverview } from '@fridgedoor/contracts';
import { decryptJson, encryptJson, type Envelope } from '../crypto.js';
import { DailyContextService, type DailyContext, type DailyContextActor, type DailyCandidate } from './daily-context.js';
import { AiUsageLedger, AiUsageLimitError } from './ai-usage.js';
import { categoryFor, DAILY_OVERVIEW_PROMPT_VERSION, DailyOverviewProviderError, type DailyOverviewProvider, type DailyOverviewUsage } from '../ai/daily-overview.js';
import { JobQueue } from '../jobs/queue.js';
import { ClarificationService } from './clarifications.js';
import { lazy, type Lazy } from '../llm/hub.js';

export const DAILY_AI_CONSENT = 'daily-assistant-v1';
type Clock = () => Date;
type SettingsRow = { enabled: number; consent_version: string; revision: number; updated_at: string };
type OverviewRow = { id: string; owner_id: string; local_date: string; timezone: string; consent_revision: number; state: 'queued'|'running'|'ready'|'failed'; revision: number; encrypted_result: string | null; encrypted_source_manifest: string | null; generated_at: string | null; expires_at: string; error_code: string | null };
type Manifest = { personalPreferences?: DailyContext['personalPreferences']; candidates: Array<Pick<DailyCandidate, 'ref'|'kind'|'title'|'normalizedTime'|'navigation'|'sourceRefs'|'revision'|'generation'|'state'>> };
export type DailyOverviewItemView = DailyOverview['items'][number] & { title: string; normalizedTime: DailyCandidate['normalizedTime']; sourceRefs: string[]; targets: DailyCandidate['navigation'][]; href: string | null };
export type DailyOverviewView = { state: 'ready' | 'fallback' | 'unavailable'; result: DailyOverview; items: DailyOverviewItemView[]; generatedAt: string | null; coverage: DailyContext['coverage']; revision: number; errorCode?: string };

export class DailyOverviewService {
  private readonly usage: AiUsageLedger;
  private readonly context: DailyContextService;
  private readonly clarification: ClarificationService;
  /** `provider` and `model` may be getters so AI settings changes apply without a restart. */
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly providerSource: Lazy<DailyOverviewProvider | undefined>, private readonly model: Lazy<string>, private readonly clock: Clock = () => new Date()) {
    this.usage = new AiUsageLedger(db, clock);
    this.context = new DailyContextService(db, key, clock);
    this.clarification = new ClarificationService(db, key, clock);
  }

  private get provider() { return lazy(this.providerSource); }

  settings(actor: DailyContextActor) {
    this.member(actor);
    const row = this.db.prepare('SELECT enabled, consent_version, revision, updated_at FROM daily_ai_settings WHERE member_id = ?').get(actor.memberId) as SettingsRow | undefined;
    return { enabled: Boolean(row?.enabled), consentVersion: row?.consent_version ?? null, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null, available: Boolean(this.provider) };
  }

  setSettings(actor: DailyContextActor, input: { enabled: boolean; expectedRevision: number; consentVersion?: string }) {
    this.member(actor);
    return this.db.transaction(() => {
      const current = this.settings(actor);
      if (current.revision !== input.expectedRevision) throw new Error('STALE_REVISION');
      if (input.enabled && input.consentVersion !== DAILY_AI_CONSENT) throw new Error('DISCLOSURE_REQUIRED');
      if (input.enabled && !this.provider) throw new Error('AI_UNAVAILABLE');
      const revision = current.revision + 1;
      const now = this.clock().toISOString();
      this.db.prepare(`INSERT INTO daily_ai_settings (member_id, enabled, consent_version, revision, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET enabled=excluded.enabled,
        consent_version=excluded.consent_version, revision=excluded.revision, updated_at=excluded.updated_at`).run(actor.memberId, Number(input.enabled), input.consentVersion ?? current.consentVersion ?? DAILY_AI_CONSENT, revision, now);
      if (!input.enabled) this.db.prepare(`UPDATE daily_overviews SET state = 'failed', encrypted_result = NULL,
        encrypted_source_manifest = NULL, error_code = 'AI_DISABLED', revision = revision + 1, updated_at = ?
        WHERE owner_id = ? AND state IN ('queued','running','ready')`).run(now, actor.memberId);
      this.db.prepare("UPDATE jobs SET state = 'canceled', error_code = 'DAILY_AI_CHANGED', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE kind IN ('daily_overview', 'daily_maintenance') AND scope_id = ? AND state IN ('ready','retry_wait','running')").run(now, `daily:${actor.memberId}`);
      return this.settings(actor);
    })();
  }

  requestRefresh(actor: DailyContextActor, queue: JobQueue, expectedRevision: number) {
    const settings = this.settings(actor);
    if (settings.revision !== expectedRevision) throw new Error('STALE_REVISION');
    if (!settings.enabled || settings.consentVersion !== DAILY_AI_CONSENT) throw new Error('AI_DISABLED');
    const context = this.context.build(actor);
    const active = this.activeRefresh(actor,context,settings.revision,queue);
    if(active) return {logicalId:active.id,state:active.state,dedupeKey:active.dedupeKey};
    const current = this.db.prepare('SELECT revision FROM daily_overviews WHERE owner_id = ? AND local_date = ? AND timezone = ?').get(actor.memberId, context.referenceDate, context.timezone) as { revision: number } | undefined;
    const dedupeKey = `daily-overview:manual:${actor.memberId}:${context.referenceDate}:${context.timezone}:${settings.revision}:${current?.revision ?? 0}`;
    const job = queue.enqueue({ kind: 'daily_overview', scopeId: `daily:${actor.memberId}`, dedupeKey, payload: { ownerId: actor.memberId, householdId: actor.householdId, localDate: context.referenceDate, timezone: context.timezone, consentRevision: settings.revision, logicalRequest: dedupeKey } });
    return { logicalId: job.id, state: job.state, dedupeKey };
  }

  async generate(actor: DailyContextActor, logicalRequest = 'manual', expected?: { localDate: string; timezone: string; consentRevision: number }) : Promise<DailyOverviewView> {
    const context = this.context.build(actor);
    const fallback = () => this.fallbackView(context, 0, 'AI_DISABLED');
    const settings = this.settings(actor);
    if (!settings.enabled || settings.consentVersion !== DAILY_AI_CONSENT) return fallback();
    const provider = this.provider;
    if (!provider) return this.fallbackView(context, 0, 'AI_UNAVAILABLE');
    if (expected && (expected.localDate !== context.referenceDate || expected.timezone !== context.timezone || expected.consentRevision !== settings.revision)) return this.fallbackView(context, 0, 'DAILY_OVERVIEW_STALE');
    let reservation;
    try {
      reservation = this.usage.reserve({ ownerId: actor.memberId, feature: 'daily_overview', logicalRequest, localDate: context.referenceDate, timezone: context.timezone, model: lazy(this.model), promptVersion: DAILY_OVERVIEW_PROMPT_VERSION });
    } catch (error) {
      if (!(error instanceof AiUsageLimitError)) throw error;
      return this.fallbackView(context, 0, 'DAILY_AI_LIMIT');
    }
    const overview = this.begin(actor, context, settings.revision);
    this.usage.markRunning(reservation.id);
    const started = this.clock().getTime();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await provider.generate(context, controller.signal);
      this.usage.record(reservation.id, { ...response.usage, outcome: 'response_received', durationMs: this.clock().getTime() - started });
      const result = dailyOverviewSchema.safeParse(response.result);
      if (!result.success) return this.reject(actor, context, overview, reservation.id, 'DAILY_OVERVIEW_INVALID', response.usage, this.clock().getTime() - started);
      if (!referencesExist(result.data, context)) return this.reject(actor, context, overview, reservation.id, 'DAILY_OVERVIEW_UNKNOWN_REF', response.usage, this.clock().getTime() - started);
      const shownRefs=new Set(result.data.items.flatMap(item=>item.refs));
      if(context.candidates.some(candidate=>candidate.required && !shownRefs.has(candidate.ref))) return this.reject(actor,context,overview,reservation.id,'DAILY_OVERVIEW_MISSING_REQUIRED',response.usage,this.clock().getTime()-started);
      if (!this.stillCurrent(actor, context, overview.revision, settings.revision)) return this.invalidate(actor, context, overview, reservation.id, 'DAILY_OVERVIEW_STALE', response.usage, this.clock().getTime() - started);
      const manifest: Manifest = { personalPreferences: context.personalPreferences ?? [], candidates: context.candidates.map(({ ref, kind, title, normalizedTime, navigation, sourceRefs, revision, generation, state }) => ({ ref, kind, title, normalizedTime, navigation, sourceRefs, revision, generation, state })) };
      const now = this.clock();
      const published = this.db.prepare(`UPDATE daily_overviews SET state = 'ready', encrypted_result = ?, encrypted_source_manifest = ?,
        generated_at = ?, expires_at = ?, error_code = NULL, updated_at = ? WHERE id = ? AND revision = ? AND consent_revision = ?`).run(
        JSON.stringify(encryptJson(result.data, this.key, `daily-overview:${overview.id}`)), JSON.stringify(encryptJson(manifest, this.key, `daily-overview-manifest:${overview.id}`)), now.toISOString(), new Date(now.getTime() + 7 * 86400000).toISOString(), now.toISOString(), overview.id, overview.revision, settings.revision,
      );
      if (published.changes !== 1) return this.invalidate(actor, context, overview, reservation.id, 'DAILY_OVERVIEW_STALE', response.usage, this.clock().getTime() - started);
      this.clarification.syncFromOverview(actor, result.data, context);
      return { state: 'ready', result: result.data, items: hydrateItems(result.data, context), generatedAt: now.toISOString(), coverage: context.coverage, revision: overview.revision };
    } catch (error) {
      const details = error instanceof DailyOverviewProviderError ? error.details : {};
      this.usage.record(reservation.id, { ...(details.usage ?? {}), outcome: error instanceof DailyOverviewProviderError ? error.code : 'AI_FAILED', durationMs: this.clock().getTime() - started });
      return this.failWithFallback(actor, context, overview, error instanceof DailyOverviewProviderError ? error.code : 'AI_FAILED');
    } finally { clearTimeout(timeout); }
  }

  private activeRefresh(actor: DailyContextActor, context: DailyContext, consentRevision: number, queue: JobQueue) {
    const row=this.db.prepare("SELECT id FROM jobs WHERE kind='daily_overview' AND scope_id=? AND state IN ('ready','running','retry_wait') AND json_extract(payload_json,'$.localDate')=? AND json_extract(payload_json,'$.timezone')=? AND json_extract(payload_json,'$.consentRevision')=? LIMIT 1").get('daily:'+actor.memberId,context.referenceDate,context.timezone,consentRevision) as {id:string}|undefined;
    return row ? queue.get(row.id) : undefined;
  }

  readOrRefresh(actor: DailyContextActor, queue: JobQueue): DailyOverviewView {
    return this.db.transaction(() => {
      const view = this.read(actor);
      const settings = this.settings(actor);
      if (view.state !== 'unavailable' || !settings.enabled || settings.consentVersion !== DAILY_AI_CONSENT || !this.provider) return view;
      const context = this.context.build(actor);
      const active = this.activeRefresh(actor,context,settings.revision,queue);
      if (active) return this.fallbackView(context,view.revision,'DAILY_OVERVIEW_UPDATING');
      const attempts = this.usage.attempts(actor.memberId,context.referenceDate,'daily_overview');
      if (!this.usage.hasCapacity(actor.memberId,context.referenceDate,'daily_overview')) return this.fallbackView(context,view.revision,'DAILY_AI_LIMIT');
      // Coalesce changes and avoid repeated paid attempts during a burst of syncs/failures.
      const last = this.db.prepare("SELECT max(created_at) AS at FROM ai_usage_attempts WHERE owner_id=? AND feature='daily_overview' AND local_date=?").get(actor.memberId,context.referenceDate) as {at:string|null};
      const runAfter = new Date(Math.max(this.clock().getTime(), last.at ? Date.parse(last.at)+300_000 : 0));
      const dedupeKey = 'daily-overview:recovery:'+actor.memberId+':'+context.referenceDate+':'+context.timezone+':'+settings.revision+':'+view.revision+':'+attempts.length;
      queue.enqueue({reviveTerminal:false,kind:'daily_overview',scopeId:'daily:'+actor.memberId,dedupeKey,runAfter,payload:{ownerId:actor.memberId,householdId:actor.householdId,localDate:context.referenceDate,timezone:context.timezone,consentRevision:settings.revision,logicalRequest:dedupeKey}});
      return this.fallbackView(context,view.revision,'DAILY_OVERVIEW_UPDATING');
    })();
  }

  read(actor: DailyContextActor): DailyOverviewView {
    const context = this.context.build(actor);
    const settings = this.settings(actor);
    const row = this.db.prepare(`SELECT * FROM daily_overviews WHERE owner_id = ? AND local_date = ? AND timezone = ?
      AND expires_at > ? ORDER BY revision DESC LIMIT 1`).get(actor.memberId, context.referenceDate, context.timezone, this.clock().toISOString()) as OverviewRow | undefined;
    if (!settings.enabled || settings.consentVersion !== DAILY_AI_CONSENT || !row || row.state !== 'ready' || row.consent_revision !== settings.revision || !row.encrypted_result || !row.encrypted_source_manifest) return this.fallbackView(context, row?.revision ?? 0, !settings.enabled ? 'AI_DISABLED' : row?.state === 'running' || row?.state === 'queued' ? 'DAILY_OVERVIEW_UPDATING' : row?.error_code && row.consent_revision === settings.revision && row.error_code !== 'AI_DISABLED' ? row.error_code : 'DAILY_OVERVIEW_UNAVAILABLE');
    let result = decryptJson<DailyOverview>(JSON.parse(row.encrypted_result) as Envelope, this.key, `daily-overview:${row.id}`);
    const dismissed = new Set((this.db.prepare('SELECT candidate_ref FROM morning_dismissals WHERE owner_id=?').all(actor.memberId) as {candidate_ref:string}[]).map(row=>row.candidate_ref));
    const manifest = decryptJson<Manifest>(JSON.parse(row.encrypted_source_manifest) as Envelope, this.key, `daily-overview-manifest:${row.id}`);
    const currentRefs=new Set(context.candidates.map(candidate=>candidate.ref));
    for(const candidate of manifest.candidates) if(candidate.navigation.kind==='task') {
      // Old swipe dismissals must not silently hide open tasks forever.
      dismissed.delete(candidate.ref);
      const task=this.db.prepare('SELECT completed_at,archived_at,snoozed_until FROM list_items WHERE id=? AND household_id=?').get(candidate.navigation.id,actor.householdId) as {completed_at:string|null;archived_at:string|null;snoozed_until:string|null}|undefined;
      if(!currentRefs.has(candidate.ref) && (!task || task.completed_at || task.archived_at || task.snoozed_until && task.snoozed_until>context.referenceDate)) dismissed.add(candidate.ref);
    }
    const keptItems = result.items.filter(item=>!item.refs.some(ref=>dismissed.has(ref)));
    result = {...result, summary:keptItems.length !== result.items.length ? 'Your remaining morning review.' : result.summary, items:keptItems, questions:result.questions.filter(item=>!item.refs.some(ref=>dismissed.has(ref))), omittedRefs:result.omittedRefs.filter(item=>!dismissed.has(item.ref))};
    if(JSON.stringify(manifest.personalPreferences??[])!==JSON.stringify(context.personalPreferences??[])) return this.fallbackView(context,row.revision,'DAILY_OVERVIEW_STALE');
    const currentByRef = new Map(context.candidates.map(candidate=>[candidate.ref,candidate]));
    const manifestByRef = new Map(manifest.candidates.map((candidate) => [candidate.ref, candidate]));
    const shownRefs = new Set(result.items.flatMap(item => item.refs));
    if (context.candidates.some(candidate => candidate.required && !shownRefs.has(candidate.ref))) return this.fallbackView(context, row.revision, 'DAILY_OVERVIEW_STALE');
    const referenced = outputRefs(result).map((ref) => manifestByRef.get(ref));
    if (referenced.some((candidate) => {
      if (!candidate) return true;
      const current = currentByRef.get(candidate.ref);
      return !current || stableCandidateFingerprint(current) !== stableCandidateFingerprint(candidate);
    })) return this.fallbackView(context, row.revision, 'DAILY_OVERVIEW_STALE');
    return { state: 'ready', result, items: hydrateItems(result, context), generatedAt: row.generated_at, coverage: context.coverage, revision: row.revision, ...(row.error_code ? { errorCode: row.error_code } : {}) };
  }

  dismiss(actor: DailyContextActor, refs: string[], expectedRevision: number) {
    return this.db.transaction(() => {
      const view=this.read(actor);
      if(view.revision!==expectedRevision) throw new Error('STALE_REVISION');
      const item=view.items.find(item=>JSON.stringify(item.refs)===JSON.stringify(refs));
      if(!item) throw new Error('NOT_FOUND');
      if(item.targets?.some(target=>target.kind==='task')) throw new Error('TASK_REQUIRES_ACTION');
      const savedAt = this.clock().toISOString();
      for(const ref of item.refs) this.db.prepare('INSERT OR IGNORE INTO morning_dismissals VALUES (?,?,?)').run(actor.memberId,ref,savedAt);
      const undoToken = JSON.stringify(encryptJson({refs:item.refs, savedAt, expiresAt:this.clock().getTime()+300_000},this.key,`morning-undo:${actor.memberId}`));
      return {...this.read(actor), undoToken};
    })();
  }

  restore(actor: DailyContextActor, token: string) {
    // The encrypted receipt is scoped to the owner and to this exact dismissal.
    this.settings(actor);
    let receipt: {refs:string[];savedAt:string;expiresAt:number};
    try { receipt=decryptJson(JSON.parse(token) as Envelope,this.key,`morning-undo:${actor.memberId}`); }
    catch { throw new Error('UNDO_UNAVAILABLE'); }
    if(!Array.isArray(receipt.refs) || !receipt.refs.length || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt<=this.clock().getTime()) throw new Error('UNDO_UNAVAILABLE');
    return this.db.transaction(()=>{
      for(const ref of receipt.refs) {
        const deleted=this.db.prepare('DELETE FROM morning_dismissals WHERE owner_id=? AND candidate_ref=? AND dismissed_at=?').run(actor.memberId,ref,receipt.savedAt);
        if(deleted.changes!==1)throw new Error('UNDO_UNAVAILABLE');
      }
      const view=this.read(actor);
      if(!view.items.some(item=>JSON.stringify(item.refs)===JSON.stringify(receipt.refs)))throw new Error('UNDO_UNAVAILABLE');
      return view;
    })();
  }

  private begin(actor: DailyContextActor, context: DailyContext, consentRevision: number) {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM daily_overviews WHERE owner_id = ? AND local_date = ? AND timezone = ?').get(actor.memberId, context.referenceDate, context.timezone) as OverviewRow | undefined;
      const id = existing?.id ?? randomUUID();
      const revision = (existing?.revision ?? 0) + 1;
      const now = this.clock().toISOString();
      if (existing) this.db.prepare(`UPDATE daily_overviews SET state = 'running', consent_revision = ?, revision = ?,
        error_code = NULL, updated_at = ? WHERE id = ?`).run(consentRevision, revision, now, id);
      else this.db.prepare(`INSERT INTO daily_overviews (id, owner_id, local_date, timezone, consent_revision, state,
        revision, encrypted_result, encrypted_source_manifest, generated_at, expires_at, error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL, ?, NULL, ?, ?)`).run(id, actor.memberId, context.referenceDate, context.timezone, consentRevision, revision, new Date(this.clock().getTime() + 7 * 86400000).toISOString(), now, now);
      return { id, revision };
    })();
  }

  private stillCurrent(actor: DailyContextActor, original: DailyContext, overviewRevision: number, consentRevision: number) {
    try {
      const settings = this.settings(actor);
      if (!settings.enabled || settings.consentVersion !== DAILY_AI_CONSENT || settings.revision !== consentRevision) return false;
      const current = this.context.build(actor);
      const row = this.db.prepare('SELECT id FROM daily_overviews WHERE owner_id = ? AND local_date = ? AND timezone = ?').get(actor.memberId, original.referenceDate, original.timezone) as { id: string } | undefined;
      return current.referenceDate === original.referenceDate && stableContextFingerprint(current) === stableContextFingerprint(original) && Boolean(row && this.db.prepare('SELECT 1 FROM daily_overviews WHERE id = ? AND revision = ?').get(row.id, overviewRevision));
    } catch { return false; }
  }

  private reject(actor: DailyContextActor, context: DailyContext, overview: { id: string; revision: number }, usageId: string, code: string, usage: DailyOverviewUsage, durationMs: number): DailyOverviewView {
    this.usage.record(usageId, { ...usage, outcome: 'rejected', durationMs });
    return this.failWithFallback(actor, context, overview, code);
  }

  private invalidate(actor: DailyContextActor, context: DailyContext, overview: { id: string; revision: number }, usageId: string, code: string, usage: DailyOverviewUsage, durationMs: number): DailyOverviewView {
    this.usage.record(usageId, { ...usage, outcome: 'invalidated', durationMs });
    this.db.prepare(`UPDATE daily_overviews SET state = 'failed', encrypted_result = NULL, encrypted_source_manifest = NULL,
      error_code = ?, updated_at = ? WHERE id = ? AND revision = ?`).run(code, this.clock().toISOString(), overview.id, overview.revision);
    return this.fallbackView(context, overview.revision, code);
  }

  private failWithFallback(actor: DailyContextActor, context: DailyContext, overview: { id: string; revision: number }, code: string) {
    this.db.prepare("UPDATE daily_overviews SET state = 'failed', encrypted_result = NULL, encrypted_source_manifest = NULL, error_code = ?, updated_at = ? WHERE id = ? AND revision = ?").run(code, this.clock().toISOString(), overview.id, overview.revision);
    return this.fallbackView(context, overview.revision, code);
  }

  private fallbackView(context: DailyContext, revision: number, code: string): DailyOverviewView {
    if (code !== 'AI_DISABLED') {
      const summary = code === 'DAILY_OVERVIEW_UPDATING' ? 'Your morning review is being updated. It will appear here automatically.'
        : code === 'DAILY_AI_LIMIT' ? 'Your morning review reached its daily generation limit. Your calendar is still available below.'
        : code === 'DAILY_OVERVIEW_STALE' ? 'Your plans changed since this review was prepared. The review needs to be refreshed.'
        : 'Your morning review could not be prepared. Your calendar is still available below.';
      return {state:'unavailable', result:{summary,items:[],questions:[],omittedRefs:[]}, items:[], generatedAt:null, coverage:context.coverage, revision, errorCode:code};
    }
    const fallback = this.context.fallback(context);
    const result: DailyOverview = { summary: fallback.summary, items: fallback.items.map((item) => ({ refs: [item.ref], category: categoryFor(context.candidates.find(candidate=>candidate.ref===item.ref)!, context), headline: item.title.slice(0, 100), detail: item.detail.slice(0, 400), priority: item.required ? 'important' as const : 'routine' as const })), questions: [], omittedRefs: [] };
    return { state: 'fallback', result, items: hydrateItems(result, context), generatedAt: null, coverage: context.coverage, revision, errorCode: code };
  }

  private member(actor: DailyContextActor) {
    const row = this.db.prepare('SELECT id FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId);
    if (!row) throw new Error('NOT_FOUND');
  }
}

function outputRefs(result: DailyOverview) { return [...result.items.flatMap((item) => item.refs), ...result.questions.flatMap((question) => question.refs), ...result.omittedRefs.map((item) => item.ref)]; }
function referencesExist(result: DailyOverview, context: DailyContext) {
  const refs = new Set(context.candidates.map((candidate) => candidate.ref));
  return outputRefs(result).every((ref) => refs.has(ref));
}
function stableContextFingerprint(context: DailyContext) {
  return createHash('sha256').update(JSON.stringify({ referenceDate: context.referenceDate, timezone: context.timezone, knowledge: context.knowledge, personalPreferences: context.personalPreferences ?? [], candidates: context.candidates.map(({ kind, title, normalizedTime, state, revision, generation, navigation, sourceRefs }) => ({ kind, title, normalizedTime, state, revision, generation, navigation, sourceRefs })) })).digest('hex');
}
function stableCandidateFingerprint(candidate: Pick<DailyCandidate, 'kind'|'title'|'normalizedTime'|'state'|'revision'|'generation'|'navigation'|'sourceRefs'>) {
  return JSON.stringify({ kind: candidate.kind, title: candidate.title, normalizedTime: candidate.normalizedTime, state: candidate.state, revision: candidate.revision, generation: candidate.generation, navigation: candidate.navigation, sourceRefs: candidate.sourceRefs });
}
function hydrateItems(result: DailyOverview, context: DailyContext): DailyOverviewItemView[] {
  const byRef = new Map(context.candidates.map((candidate) => [candidate.ref, candidate]));
  return result.items.flatMap((item) => {
    const candidates = item.refs.map((ref) => byRef.get(ref)).filter((candidate): candidate is DailyCandidate => Boolean(candidate));
    if (!candidates.length) return [];
    const first = candidates[0]!;
    return [{ ...item, title: candidates.map((candidate) => candidate.title).join(' · ').slice(0, 100), normalizedTime: first.normalizedTime, sourceRefs: [...new Set(candidates.flatMap((candidate) => candidate.sourceRefs))], targets: candidates.map(candidate=>candidate.navigation), href: first.navigation.kind === 'plan' ? `/plans/${encodeURIComponent(first.navigation.id)}` : first.navigation.kind === 'task' ? '/todos' : null }];
  });
}
