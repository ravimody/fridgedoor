import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { assistantResultSchema, type AssistantResult, type AssistantRun, type AssistantReview } from '@fridgedoor/contracts';
import { encryptJson, decryptJson, type Envelope } from '../crypto.js';
import { JobQueue, type JobRecord } from '../jobs/queue.js';
import { CaptureService } from '../services/captures.js';
import { ListService } from '../services/lists.js';
import { CalendarRepository } from '../repos/calendar.js';
import type { PlanDecisionService } from '../services/plan-decisions.js';
import { PlanRepository } from '../repos/plans.js';
import { dailyCalendarWindow } from '../services/daily-context.js';
import { KnowledgeRepository } from '../repos/knowledge.js';
import type { AgentProvider, AgentPacket } from './agent.js';
import { lazy, type Lazy } from '../llm/hub.js';

export const ASSISTANT_CONSENT = 'interactive-v1';
type Actor = { memberId: string; householdId: string };
type RunRow = { id: string; owner_id: string; client_id: string; capture_id: string | null; encrypted_input: string; encrypted_result: string | null; state: string; applied_at: string | null; plan_ids_json: string | null; error_code: string | null; feedback: string | null; metrics_json: string | null; created_at: string; expires_at: string };

export class AssistantService {
  private readonly queue: JobQueue;
  private readonly knowledgeRepo: KnowledgeRepository;
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly enabled: Lazy<boolean>, private readonly provider?: AgentProvider, private readonly clock: () => Date = () => new Date(), private readonly decisions?: PlanDecisionService) { this.queue = new JobQueue(db, clock); this.knowledgeRepo = new KnowledgeRepository(db, key, clock); }
  private member(actor: Actor) {
    const row = this.db.prepare('SELECT timezone FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId) as { timezone: string } | undefined;
    if (!row) throw new Error('NOT_FOUND'); return row;
  }
  private encode(value: unknown, context: string) { return JSON.stringify(encryptJson(value, this.key, context)); }
  private decode<T>(value: string, context: string) { return decryptJson<T>(JSON.parse(value) as Envelope, this.key, context); }
  /** Whether the assistant is switched on and has a model, regardless of member consent. */
  available() { return lazy(this.enabled); }
  settings(actor: Actor) { this.member(actor); return { enabled: this.available(), consent: Boolean(this.db.prepare('SELECT 1 FROM assistant_settings WHERE member_id = ? AND consent_version = ?').get(actor.memberId, ASSISTANT_CONSENT)) }; }
  presence(actor: Actor, clientId: string, visible: boolean) {
    this.member(actor);
    if (visible) this.db.prepare('INSERT INTO activity_presence VALUES (?, ?, ?) ON CONFLICT(member_id,client_id) DO UPDATE SET seen_at=excluded.seen_at').run(actor.memberId, clientId, this.clock().toISOString());
    else this.db.prepare('DELETE FROM activity_presence WHERE member_id=? AND client_id=?').run(actor.memberId, clientId);
  }
  consent(actor: Actor, enabled: boolean) {
    this.member(actor);
    if (enabled) this.db.prepare('INSERT INTO assistant_settings VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET consent_version = excluded.consent_version, updated_at = excluded.updated_at').run(actor.memberId, ASSISTANT_CONSENT, this.clock().toISOString());
    else { this.db.prepare('DELETE FROM assistant_settings WHERE member_id = ?').run(actor.memberId); this.queue.cancelScope(`assistant:${actor.memberId}`, 'ASSISTANT_DISABLED'); this.db.prepare("UPDATE assistant_runs SET state = 'failed', error_code = 'ASSISTANT_DISABLED' WHERE owner_id = ? AND state IN ('queued','running')").run(actor.memberId); }
    return this.settings(actor);
  }
  private allowed(actor: Actor) { const settings = this.settings(actor); if (!settings.enabled || !settings.consent) throw new Error('ASSISTANT_CONSENT_REQUIRED'); }
  submit(actor: Actor, clientId: string, text: string, captureId?: string) {
    this.allowed(actor);
    if (!text.trim() && !captureId) throw new Error('INPUT_REQUIRED');
    if (text.length > 8000 || clientId.length > 100) throw new Error('INPUT_TOO_LARGE');
    if (captureId) new CaptureService(this.db, this.key, this.clock).status(actor, captureId);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM assistant_runs WHERE owner_id = ? AND client_id = ?').get(actor.memberId, clientId) as RunRow | undefined;
      if (existing) {
        if (this.decode<string>(existing.encrypted_input, `assistant:${existing.id}`) !== text || existing.capture_id !== (captureId ?? null)) throw new Error('IDEMPOTENCY_CONFLICT');
        return { id: existing.id };
      }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM assistant_runs WHERE owner_id = ? AND state IN ('queued','running')").get(actor.memberId) as { n: number };
      if (count.n >= 10) throw new Error('ASSISTANT_BUSY');
      const id = randomUUID(); const now = this.clock();
      this.db.prepare('INSERT INTO assistant_runs (id, owner_id, client_id, capture_id, encrypted_input, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, actor.memberId, clientId, captureId ?? null, this.encode(text, `assistant:${id}`), now.toISOString(), new Date(now.getTime() + 7 * 86400000).toISOString());
      this.queue.enqueue({ kind: 'assistant', scopeId: `assistant:${actor.memberId}`, dedupeKey: `assistant:${id}`, payload: { assistantRunId: id } });
      return { id };
    })();
  }
  dispatchCapture(job: JobRecord) {
    // The handoff is durable even if the assistant is busy or consent is pending.
    const capture = this.db.prepare(`SELECT c.id, c.owner_id, c.household_id, c.created_at
      FROM captures c JOIN members m ON m.id = c.owner_id AND m.household_id = c.household_id
      WHERE c.id = ? AND c.state != 'expired' AND m.active = 1`).get(job.payload.captureId) as { id: string; owner_id: string; household_id: string; created_at: string } | undefined;
    if (!capture || Date.parse(capture.created_at) <= this.clock().getTime() - 7 * 86400000) {
      this.queue.fail(job, 'CAPTURE_UNAVAILABLE'); return;
    }
    const actor = { memberId: capture.owner_id, householdId: capture.household_id };
    try {
      this.db.transaction(() => {
        if (!this.queue.heartbeat(job)) return;
        const run = this.submit(actor, `shortcut:${capture.id}`, '', capture.id);
        // Relative dates refer to submission, even when dispatch waited for consent.
        this.db.prepare('UPDATE assistant_runs SET created_at = ?, expires_at = ? WHERE id = ? AND state = ?')
          .run(capture.created_at, new Date(Date.parse(capture.created_at) + 7 * 86400000).toISOString(), run.id, 'queued');
        this.queue.finish(job);
      })();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'ASSISTANT_CONSENT_REQUIRED' || code === 'ASSISTANT_BUSY') {
        this.queue.retry(job, code, new Date(this.clock().getTime() + (code === 'ASSISTANT_BUSY' ? 60_000 : 300_000)));
      } else throw error;
    }
  }
  private row(actor: Actor, id: string) { this.member(actor); const row = this.db.prepare('SELECT * FROM assistant_runs WHERE id = ? AND owner_id = ? AND expires_at > ?').get(id, actor.memberId, this.clock().toISOString()) as RunRow | undefined; if (!row) throw new Error('NOT_FOUND'); return row; }
  list(actor: Actor): AssistantRun[] {
    this.member(actor);
    return (this.db.prepare('SELECT * FROM assistant_runs WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC').all(actor.memberId, this.clock().toISOString()) as RunRow[]).map((row) => ({ reviews: this.reviews(row), id: row.id, text: this.decode<string>(row.encrypted_input, `assistant:${row.id}`), captureId: row.capture_id, state: row.state, createdAt: row.created_at, result: row.encrypted_result ? this.decode<AssistantResult>(row.encrypted_result, `assistant-result:${row.id}`) : null, applied: Boolean(row.applied_at), planIds: row.plan_ids_json ? JSON.parse(row.plan_ids_json) as string[] : [], errorCode: row.error_code, feedback: row.feedback, metrics: row.metrics_json ? JSON.parse(row.metrics_json) as AssistantRun['metrics'] : null }));
  }
  knowledge(actor: Actor) { return this.knowledgeRepo.list(actor); }
  knowledgeHistory(actor: Actor, key?: string) { return this.knowledgeRepo.history(actor, key); }
  undoKnowledge(actor: Actor, id: string, expectedRevision: number) { return this.knowledgeRepo.undo(actor, id, expectedRevision); }
  setKnowledge(actor: Actor, key: string, value: string, expectedRevision: number, origin: 'user' | 'review' = 'user') { return this.knowledgeRepo.set(actor, { key, value, expectedRevision, provenance: 'user', confirmation: 'confirmed', reason: origin === 'review' ? 'assistant-review' : 'user-edit', origin }); }
  forget(actor: Actor, key: string, expectedRevision: number) { return this.knowledgeRepo.forget(actor, key, expectedRevision); }
  feedback(actor: Actor, id: string, value: 'helpful' | 'needs_work') { this.row(actor, id); this.db.prepare('UPDATE assistant_runs SET feedback = ? WHERE id = ?').run(value, id); }
  remove(actor: Actor, id: string) { this.row(actor, id); const job = this.queue.getByDedupe(`assistant:${id}`); if (job) this.db.prepare("UPDATE jobs SET state = 'canceled', lease_token = NULL, lease_until = NULL WHERE id = ?").run(job.id); this.db.prepare('DELETE FROM assistant_runs WHERE id = ?').run(id); }
  retry(actor: Actor, id: string) { this.allowed(actor); const row = this.row(actor, id); if (row.state !== 'failed') throw new Error('RUN_NOT_FAILED'); this.db.transaction(() => { this.db.prepare("UPDATE assistant_runs SET state = 'queued', error_code = NULL WHERE id = ?").run(id); this.queue.enqueue({ kind: 'assistant', scopeId: `assistant:${actor.memberId}`, dedupeKey: `assistant:${id}`, payload: { assistantRunId: id } }); this.db.prepare("UPDATE jobs SET attempt_count = 0 WHERE dedupe_key = ?").run(`assistant:${id}`); })(); }
  async run(job: JobRecord) {
    const row = this.db.prepare('SELECT * FROM assistant_runs WHERE id = ? AND expires_at > ?').get(job.payload.assistantRunId, this.clock().toISOString()) as RunRow | undefined;
    if (!row || row.state === 'succeeded') { this.queue.finish(job); return; }
    const member = this.db.prepare('SELECT household_id FROM members WHERE id = ? AND active = 1').get(row.owner_id) as { household_id: string } | undefined;
    if (!member || !this.provider || job.attemptCount > 3) { if (this.queue.fail(job, 'ASSISTANT_UNAVAILABLE')) this.db.prepare("UPDATE assistant_runs SET state = 'failed', error_code = 'ASSISTANT_UNAVAILABLE' WHERE id = ?").run(row.id); return; }
    const actor = { memberId: row.owner_id, householdId: member.household_id };
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 120_000);
    const heartbeat = setInterval(() => { if (!this.queue.heartbeat(job)) controller.abort(); }, 15_000);
    try {
      this.allowed(actor); if (!this.queue.heartbeat(job)) return;
      this.db.prepare("UPDATE assistant_runs SET state = 'running' WHERE id = ?").run(row.id);
      const packet: AgentPacket = { text: this.decode<string>(row.encrypted_input, `assistant:${row.id}`), referenceTime: row.created_at, timezone: this.member(actor).timezone, knowledge: this.knowledge(actor), history: this.list(actor).filter((r) => r.state === 'succeeded' && r.createdAt <= row.created_at).slice(0, 3).reverse().map((r) => ({ text: r.text.slice(0, 2000), reply: r.result?.reply.slice(0, 2000), items: r.result?.items, applied: r.applied })) };
      if (row.capture_id) {
        const capture = this.db.prepare('SELECT kind, mime_type, text_value FROM captures WHERE id = ? AND owner_id = ? AND state != ?').get(row.capture_id, actor.memberId, 'expired') as { kind: string; mime_type: string; text_value: string | null } | undefined;
        if (!capture) throw new Error('CAPTURE_UNAVAILABLE');
        if (capture.kind === 'file') packet.media = { mimeType: capture.mime_type, base64: new CaptureService(this.db, this.key, this.clock).readBlob(actor, row.capture_id).toString('base64') };
        else packet.text += `\nAttached capture: ${capture.text_value ?? ''}`;
      }
      const output = await this.provider.run(packet, () => { this.allowed(actor); if (!this.queue.heartbeat(job)) throw new Error('AGENT_CANCELED'); const member = this.member(actor); return { agenda: new CalendarRepository(this.db, this.key, this.clock).agendaSafe(actor, dailyCalendarWindow(this.clock(), member.timezone)), plans: new PlanRepository(this.db, this.key, this.clock).list(actor.memberId).slice(0, 30).map((p) => ({ facts: p.facts, status: p.status })), groceries: new ListService(this.db, this.key).list(actor, 'grocery').filter((i) => !i.completedAt).slice(0, 100), todos: new ListService(this.db, this.key).list(actor, 'todo').filter((i) => !i.completedAt).slice(0, 100) }; }, controller.signal);
      this.db.transaction(() => {
        this.allowed(actor); this.row(actor, row.id);
        if (!this.queue.finish(job)) return;
        this.db.prepare("UPDATE assistant_runs SET state = 'succeeded', encrypted_result = ?, metrics_json = ?, error_code = NULL WHERE id = ?").run(this.encode(assistantResultSchema.parse(output.result), `assistant-result:${row.id}`), JSON.stringify(output.metrics), row.id);
        // Only new, direct text commands can change lists without another review.
        // Uploaded/captured sources, public lookup and shared-document results remain proposals.
        if (!row.capture_id && packet.text.trim() && !output.result.sources.length && !output.metrics.tools.some((tool) => ['public_lookup', 'web_search', 'read_shared_document'].includes(tool))) {
          output.result.items.forEach((item, index) => {
            if (item.kind !== 'event' && item.intent === 'direct') {
              this.review(actor, row.id, 'item', index, 'save');
              this.db.prepare('UPDATE assistant_item_reviews SET automatic = 1 WHERE run_id = ? AND target = ?').run(row.id, `item:${index}`);
            }
          });
        }
        if (row.capture_id) this.db.prepare("UPDATE captures SET state = 'ready' WHERE id = ?").run(row.capture_id);
      })();
    } catch (error) {
      const code = error instanceof Error && /^AGENT_[A-Z_]+$/.test(error.message) ? error.message : 'ASSISTANT_FAILED';
      if (this.queue.fail(job, code)) this.db.prepare("UPDATE assistant_runs SET state = 'failed', error_code = ? WHERE id = ?").run(code, row.id);
    } finally { clearTimeout(timeout); clearInterval(heartbeat); }
  }
  private reviews(row: RunRow): AssistantReview[] {
    const saved = (this.db.prepare('SELECT target, state, plan_id as planId, automatic, undone_at as undoneAt FROM assistant_item_reviews WHERE run_id = ?').all(row.id) as AssistantReview[]).map((entry) => {
      const action = entry.planId ? this.db.prepare("SELECT a.state, a.kind FROM calendar_actions a JOIN plans p ON p.id = a.plan_id JOIN members m ON m.household_id = p.household_id WHERE a.plan_id = ? AND m.id = ? AND m.active = 1 AND (p.visibility = 'shared' OR p.owner_id = m.id) ORDER BY a.rowid DESC LIMIT 1").get(entry.planId, row.owner_id) as AssistantReview['calendarAction'] : undefined;
      return { ...entry, automatic: Boolean(entry.automatic), ...(action ? { calendarAction: action } : {}) };
    });
    if (!row.applied_at || !row.encrypted_result) return saved;
    const result = this.decode<AssistantResult>(row.encrypted_result, `assistant-result:${row.id}`);
    const ids = JSON.parse(row.plan_ids_json ?? '[]') as string[]; let eventIndex = 0;
    const legacy: AssistantReview[] = result.items.map((item, index) => ({ target: `item:${index}`, state: item.kind === 'event' ? 'draft' : 'saved', planId: item.kind === 'event' ? ids[eventIndex++] ?? null : null }));
    result.knowledge.forEach((_, index) => legacy.push({ target: `knowledge:${index}`, state: 'saved', planId: null }));
    return legacy.map((item) => saved.find((entry) => entry.target === item.target) ?? item);
  }
  review(actor: Actor, id: string, target: 'item' | 'knowledge', index: number, choice: 'save' | 'keep' | 'calendar' | 'dismiss', edited?: AssistantResult['items'][number]) {
    return this.db.transaction(() => {
      const row = this.row(actor, id);
      if (row.state !== 'succeeded' || !row.encrypted_result) throw new Error('RESULT_NOT_READY');
      const result = assistantResultSchema.parse(this.decode(row.encrypted_result, `assistant-result:${id}`));
      if (!Number.isInteger(index) || index < 0 || index >= result[target === 'item' ? 'items' : 'knowledge'].length) throw new Error('NOT_FOUND');
      const name = `${target}:${index}`; const previous = this.reviews(row).find((entry) => entry.target === name);
      if (previous && !['draft', 'kept'].includes(previous.state)) return previous;
      if (previous?.state === 'kept' && choice !== 'calendar') return previous;
      let listItem: { id: string; revision: number } | undefined;
      let planId = previous?.planId ?? null;
      let state: AssistantReview['state'] = 'saved';
      if (choice === 'dismiss') {
        if (planId) { const plans = new PlanRepository(this.db, this.key, this.clock); const plan = plans.detail(planId, actor.memberId); if (plan.calendarAction) throw new Error('PLAN_ALREADY_APPLIED'); plans.dismiss(planId, actor.memberId, plan.revision); }
        state = 'dismissed';
      }
      else if (target === 'knowledge') {
        if (choice !== 'save' || edited) throw new Error('INVALID_DECISION');
        const fact = result.knowledge[index]!;
        const currentRevision = this.knowledgeRepo.get(actor, fact.key)?.revision ?? 0;
        if (fact.operation === 'delete') this.forget(actor, fact.key, currentRevision);
        else { if (!fact.value) throw new Error('INVALID_FACT'); this.setKnowledge(actor, fact.key, fact.value, currentRevision, 'review'); }
      } else {
        const original = result.items[index]!;
        const item = edited ? assistantResultSchema.shape.items.element.parse(edited) : original;
        if (item.kind !== original.kind) throw new Error('INVALID_DECISION');
        if (item.kind !== 'event') {
          if (choice !== 'save') throw new Error('INVALID_DECISION');
          listItem = new ListService(this.db, this.key, this.clock).create(actor, item.kind, item.title, item.quantity ?? undefined, undefined, item.start ?? undefined, `assistant:${id}:${index}`);
        } else {
          if (!['keep', 'calendar'].includes(choice) || !this.decisions) throw new Error('INVALID_DECISION');
          const plans = new PlanRepository(this.db, this.key, this.clock);
          if (!planId) planId = plans.createPrivate(actor, { title: item.title, category: 'household', participants: [], preparationTasks: [], unresolvedFields: !item.start || !item.end ? ['time'] : [], ...(item.start ? { time: item.end ? { kind: 'timed' as const, start: item.start, end: item.end, timezone: this.member(actor).timezone } : { kind: 'unresolved' as const, startHint: item.start, missing: ['end' as const] } } : {}), ...(item.location ? { location: item.location } : {}), notes: [item.notes, ...result.assumptions].filter(Boolean).join('\n').slice(0, 2000) });
          else if (edited) throw new Error('EDIT_SAVED_PLAN');
          this.decisions.decide(actor, planId, plans.detail(planId, actor.memberId).revision, choice as 'keep' | 'calendar');
          state = choice === 'keep' ? 'kept' : 'calendar';
        }
      }
      this.db.prepare('INSERT INTO assistant_item_reviews (run_id, target, state, plan_id) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, target) DO UPDATE SET state = excluded.state, plan_id = excluded.plan_id').run(id, name, state, planId);
      if (listItem) this.db.prepare('UPDATE assistant_item_reviews SET list_item_id = ?, list_revision = ? WHERE run_id = ? AND target = ?').run(listItem.id, listItem.revision, id, name);
      return this.reviews(row).find((entry) => entry.target === name)!;
    })();
  }
  undo(actor: Actor, id: string, index: number) {
    return this.db.transaction(() => {
      this.row(actor, id);
      const name = `item:${index}`;
      const receipt = this.db.prepare('SELECT automatic, list_item_id, list_revision, undone_at FROM assistant_item_reviews WHERE run_id = ? AND target = ?').get(id, name) as { automatic: number; list_item_id: string | null; list_revision: number; undone_at: string | null } | undefined;
      if (!receipt?.automatic) throw new Error('UNDO_UNAVAILABLE');
      if (receipt.undone_at) return { undone: true };
      if (!receipt.list_item_id) throw new Error('UNDO_UNAVAILABLE');
      new ListService(this.db, this.key, this.clock).archive(actor, receipt.list_item_id, receipt.list_revision);
      this.db.prepare("UPDATE assistant_item_reviews SET state = 'dismissed', undone_at = ? WHERE run_id = ? AND target = ?").run(this.clock().toISOString(), id, name);
      return { undone: true };
    })();
  }
  apply(actor: Actor, id: string) {
    return this.db.transaction(() => {
      const row = this.row(actor, id); if (this.db.prepare('SELECT 1 FROM assistant_item_reviews WHERE run_id = ?').get(id)) throw new Error('RESULT_PARTIALLY_REVIEWED'); if (row.applied_at) return { planIds: JSON.parse(row.plan_ids_json ?? '[]') as string[] };
      if (row.state !== 'succeeded' || !row.encrypted_result) throw new Error('RESULT_NOT_READY');
      const result = assistantResultSchema.parse(this.decode(row.encrypted_result, `assistant-result:${id}`));
      const plans = new PlanRepository(this.db, this.key, this.clock); const lists = new ListService(this.db, this.key, this.clock); const planIds: string[] = [];
      result.items.forEach((item, index) => {
        if (item.kind !== 'event') lists.create(actor, item.kind, item.title, item.quantity ?? undefined, undefined, item.start ?? undefined, `assistant:${id}:${index}`);
        else planIds.push(plans.createPrivate(actor, { title: item.title, category: 'household', participants: [], preparationTasks: [], unresolvedFields: !item.start || !item.end ? ['time'] : [], ...(item.start ? { time: item.end ? { kind: 'timed' as const, start: item.start, end: item.end, timezone: this.member(actor).timezone } : { kind: 'unresolved' as const, startHint: item.start, missing: ['end' as const] } } : {}), ...(item.location ? { location: item.location } : {}), notes: [item.notes, ...result.assumptions, ...result.followups].filter(Boolean).join('\n').slice(0, 2000) }));
      });
      for (const fact of result.knowledge) {
        const currentRevision = this.knowledgeRepo.get(actor, fact.key)?.revision ?? 0;
        if (fact.operation === 'delete') this.forget(actor, fact.key, currentRevision);
        else if (fact.value) this.setKnowledge(actor, fact.key, fact.value, currentRevision, 'review');
      }
      if (this.knowledge(actor).length > 50) throw new Error('KNOWLEDGE_LIMIT');
      this.db.prepare('UPDATE assistant_runs SET applied_at = ?, plan_ids_json = ? WHERE id = ?').run(this.clock().toISOString(), JSON.stringify(planIds), id);
      return { planIds };
    })();
  }
}
