import { PlanAttentionService } from '../services/plan-attention.js';
import { RelevanceTrialService } from '../services/relevance-trial.js';
import { createTrialSummaryProvider } from '../ai/relevance-summary.js';
import { ActivityNotificationService } from '../services/activity-notifications.js';
import { MorningDigestService } from '../services/morning-digest.js';
import { AssistantService } from '../ai/assistant-service.js';
import { LlmAgent } from '../ai/agent.js';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { keyFromSecret } from '../crypto.js';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createGoogleProvider, type GoogleProvider } from '../providers/google.js';
import { backgroundAiEnabled, createAiProvider, type AiProvider } from '../providers/ai.js';
import { LlmHub } from '../llm/hub.js';
import { resolveAiConfig, SettingsStore } from '../settings.js';
import { ExtractionService } from '../ai/extract.js';
import { SourceRepository } from '../repos/sources.js';
import { ImapSync, MailSync } from '../sync/imap.js';
import { GmailSync } from '../sync/gmail.js';
import { CalendarSync } from '../sync/calendar.js';
import { CalendarRepository } from '../repos/calendar.js';
import { PlanRepository } from '../repos/plans.js';
import { SuggestionService } from '../domain/suggestions.js';
import { CalendarActionService } from '../services/calendar-actions.js';
import { JobQueue, type JobKind } from './queue.js';
import { Scheduler } from './scheduler.js';
import { ReminderService } from '../services/reminders.js';
import { createPushProvider } from '../providers/push.js';
import { DailyOverviewService } from '../services/daily-overview.js';
import { createDailyOverviewProvider } from '../ai/daily-overview.js';
import { createKnowledgeMaintenanceProvider } from '../ai/knowledge-maintenance.js';
import { KnowledgeMaintenanceService } from '../services/knowledge-maintenance.js';

export type WorkerLog = (event: string, fields: { jobId?: string; kind?: string; code?: string; durationMs?: number }) => void;
const safeDefaultLog: WorkerLog = (event, fields) => console.info(JSON.stringify({ event, ...fields }));

export class Worker {
  private readonly enabledKinds: JobKind[];
  private lastHeartbeatAt = 0;
  constructor(private readonly queue: JobQueue, private readonly sync: Pick<GmailSync, 'run'>, private readonly db: Database.Database, private readonly scheduler?: Scheduler, private readonly clock: () => Date = () => new Date(), private readonly log: WorkerLog = safeDefaultLog, private readonly calendarSync?: CalendarSync, private readonly extraction?: ExtractionService, private readonly actions?: CalendarActionService, private readonly reminders?: ReminderService, private readonly assistant?: AssistantService, private readonly digest?: MorningDigestService, private readonly activity?: ActivityNotificationService, private readonly dailyOverview?: DailyOverviewService, private readonly knowledgeMaintenance?: KnowledgeMaintenanceService, private readonly relevanceLearning?: RelevanceTrialService) { this.enabledKinds = [...(relevanceLearning ? ['relevance_learning' as const] : []),...(digest ? ['morning_digest' as const] : []),...(assistant ? ['assistant' as const, 'capture_dispatch' as const] : []), 'gmail_sync', 'calendar_sync', 'retention', 'reminder_delivery', ...(extraction ? ['extract_source' as const] : []), ...(actions ? ['calendar_action' as const] : []), ...(dailyOverview ? ['daily_overview' as const] : []), ...(knowledgeMaintenance ? ['daily_maintenance' as const] : [])]; }
  // AI settings can change while running; until AI is available again, its jobs wait in the queue.
  private claimableKinds() {
    return this.enabledKinds.filter((kind) => kind === 'extract_source' ? this.extraction?.ready() : kind === 'assistant' || kind === 'capture_dispatch' ? this.assistant?.available() : true);
  }
  private heartbeat() {
    const now = this.clock();
    if (now.getTime() - this.lastHeartbeatAt < 15_000) return;
    this.db.prepare(`INSERT INTO worker_health (id, last_seen_at) VALUES ('planner-worker', ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(now.toISOString());
    this.lastHeartbeatAt = now.getTime();
  }
  async runOnce() {
    this.heartbeat();
    this.queue.recoverExpired();
    this.queue.reconcileCalendarActions();
    const job = this.queue.claim(this.claimableKinds()); if (!job) return false;
    const started = this.clock().getTime();
    try {
      if (job.kind === 'capture_dispatch') {
        this.assistant?.dispatchCapture(job);
      } else if (job.kind === 'assistant') {
        await this.assistant?.run(job);
      } else if (job.kind === 'gmail_sync') {
        const result = await this.sync.run(job);
        if (result.state === 'retry') { if (result.retryKind === 'transient' && job.attemptCount >= 6) this.queue.fail(job, 'RETRY_LIMIT'); else this.queue.retry(job, 'CONTINUE', new Date(this.clock().getTime() + (result.delayMs ?? 30_000))); } else this.queue.finish(job);
      } else if (job.kind === 'calendar_sync') {
        if (!this.calendarSync) throw new Error('CALENDAR_HANDLER_UNAVAILABLE');
        const result = await this.calendarSync.run(job);
        if (result.state === 'retry') { if (result.retryKind === 'transient' && job.attemptCount >= 6) this.queue.fail(job, 'RETRY_LIMIT'); else this.queue.retry(job, 'CONTINUE', new Date(this.clock().getTime() + (result.delayMs ?? 30_000))); }
        else this.queue.finish(job);
      } else if (job.kind === 'extract_source') {
        if (!this.extraction) throw new Error('EXTRACTION_HANDLER_UNAVAILABLE');
        const result = await this.extraction.run(job);
        if (result.state === 'retry') { this.queue.retry(job, result.retryKind === 'capacity' ? 'AI_CAPACITY_WAIT' : 'AI_RETRY', new Date(this.clock().getTime() + (result.delayMs ?? 30_000))); } else this.queue.finish(job);
      } else if (job.kind === 'calendar_action') {
        if (!this.actions) throw new Error('ACTION_HANDLER_UNAVAILABLE');
        const result = await this.actions.run(job); if (result.state === 'retry') { if (job.attemptCount >= 6) this.queue.fail(job, 'ACTION_RETRY_LIMIT'); else this.queue.retry(job, 'ACTION_RETRY', new Date(this.clock().getTime() + (result.delayMs ?? 30_000))); } else this.queue.finish(job);
      } else if (job.kind === 'daily_overview') {
        if (!this.dailyOverview || !job.payload.ownerId || !job.payload.householdId || !job.payload.localDate || !job.payload.timezone || job.payload.consentRevision === undefined) throw new Error('DAILY_OVERVIEW_HANDLER_UNAVAILABLE');
        const review = await this.dailyOverview.generate({ memberId: job.payload.ownerId, householdId: job.payload.householdId }, job.payload.logicalRequest ?? job.dedupeKey, { localDate: job.payload.localDate, timezone: job.payload.timezone, consentRevision: job.payload.consentRevision });
        if (review.state === 'unavailable') this.queue.fail(job, review.errorCode ?? 'DAILY_OVERVIEW_UNAVAILABLE');
        else this.queue.finish(job);
      } else if (job.kind === 'daily_maintenance') {
        if (!this.knowledgeMaintenance || !job.payload.ownerId || !job.payload.householdId || !job.payload.localDate || !job.payload.timezone || job.payload.consentRevision === undefined) throw new Error('DAILY_MAINTENANCE_HANDLER_UNAVAILABLE');
        await this.knowledgeMaintenance.maintain({ memberId: job.payload.ownerId, householdId: job.payload.householdId }, job.payload.logicalRequest ?? job.dedupeKey, [], { localDate: job.payload.localDate, timezone: job.payload.timezone, consentRevision: job.payload.consentRevision });
        this.queue.finish(job);
      } else if (job.kind === 'relevance_learning') {
        if(!this.relevanceLearning || !job.payload.ownerId || !job.payload.householdId || !job.payload.localDate || !job.payload.timezone || job.payload.consentRevision===undefined) throw new Error('LEARNING_HANDLER_UNAVAILABLE');
        await this.relevanceLearning.learn({memberId:job.payload.ownerId,householdId:job.payload.householdId},{localDate:job.payload.localDate,timezone:job.payload.timezone,consentRevision:job.payload.consentRevision});
        this.queue.finish(job);
      } else if (job.kind === 'retention') {
        this.db.prepare('DELETE FROM plan_attention WHERE expires_at <= ?').run(this.clock().toISOString());
        this.db.prepare('DELETE FROM relevance_trial_summaries WHERE expires_at <= ?').run(this.clock().toISOString());
        this.db.prepare('DELETE FROM relevance_trial_items WHERE expires_at <= ?').run(this.clock().toISOString());
        this.db.prepare('DELETE FROM digest_days WHERE expires_at <= ?').run(new Date(this.clock().getTime() - 8 * 86400000).toISOString());
        this.db.prepare('DELETE FROM background_ai_attempts WHERE attempted_at <= ?').run(new Date(this.clock().getTime() - 8 * 86400000).toISOString());
        this.db.prepare('DELETE FROM ai_usage_attempts WHERE created_at <= ?').run(new Date(this.clock().getTime() - 30 * 86400000).toISOString());
        this.db.prepare('DELETE FROM daily_overviews WHERE expires_at <= ?').run(this.clock().toISOString());
        this.db.prepare('DELETE FROM clarifications WHERE expires_at <= ?').run(this.clock().toISOString());
        this.db.prepare('DELETE FROM knowledge_changes WHERE undo_until <= ?').run(this.clock().toISOString());
        this.db.prepare('DELETE FROM knowledge_proposals WHERE expires_at <= ?').run(this.clock().toISOString());
        this.db.prepare('DELETE FROM knowledge_tombstones WHERE created_at <= ?').run(new Date(this.clock().getTime() - 30 * 86400000).toISOString());
        this.db.prepare('DELETE FROM knowledge_maintenance_runs WHERE completed_at <= ?').run(new Date(this.clock().getTime() - 30 * 86400000).toISOString());
        this.db.prepare('DELETE FROM assistant_knowledge WHERE archived_at IS NOT NULL AND archived_at <= ?').run(new Date(this.clock().getTime() - 30 * 86400000).toISOString());
        this.db.prepare('DELETE FROM assistant_runs WHERE expires_at <= ?').run(this.clock().toISOString());
        this.db.prepare("UPDATE captures SET encrypted_blob = NULL, text_value = NULL, state = 'expired' WHERE created_at <= ?").run(new Date(this.clock().getTime() - 7 * 86400000).toISOString());
        this.db.prepare("UPDATE source_versions SET availability = 'expired', encrypted_evidence = '' WHERE expires_at <= ? AND availability = 'available'").run(this.clock().toISOString());
        this.db.prepare("UPDATE extractions SET state = 'expired', encrypted_result = NULL, updated_at = ? WHERE expires_at <= ? AND state = 'succeeded'").run(this.clock().toISOString(), this.clock().toISOString());
        this.queue.finish(job);
      } else if (job.kind === 'morning_digest') {
        await this.digest?.deliverDue();
        this.queue.finish(job);
      } else if (job.kind === 'reminder_delivery') {
        if (!this.reminders) throw new Error('REMINDER_HANDLER_UNAVAILABLE');
        await this.reminders.deliverDue();
        await this.activity?.deliverDue();
        this.queue.finish(job);
      }
      this.log('job_finished', { jobId: job.id, kind: job.kind, durationMs: this.clock().getTime() - started });
    } catch (error) {
      const code = job.kind==='relevance_learning' ? 'LEARNING_FAILED' : error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : 'WORKER_FAILED';
      if(job.kind==='relevance_learning' || job.attemptCount>=6) this.queue.fail(job,code);
      else this.queue.retry(job, code, new Date(this.clock().getTime() + 30_000));
      this.log('job_failed', { jobId: job.id, kind: job.kind, code, durationMs: this.clock().getTime() - started });
    }
    return true;
  }
  start(intervalMs = 1_000) {
    this.heartbeat();
    this.scheduler?.tick();
    let processing = false;
    const tick = async () => {
      this.heartbeat();
      if (processing) return;
      processing = true;
      try { this.scheduler?.tick(); for (;;) { const worked = await this.runOnce(); if (!worked) break; } }
      finally { processing = false; }
    };
    void tick();
    return setInterval(() => { void tick(); }, intervalMs);
  }
}

/** `llm` and `ai` let tests and previews inject fakes; by default AI settings are read from the environment and the database on every use. */
export function createWorker(config = loadConfig(), google?: GoogleProvider, llm?: LlmHub, ai?: AiProvider) {
  mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  const db = new Database(config.DATABASE_PATH); migrate(db);
  const provider = google ?? createGoogleProvider(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET);
  const key = keyFromSecret(config.SESSION_SECRET); const queue = new JobQueue(db); const sources = new SourceRepository(db, key); const calendarRepo = new CalendarRepository(db, key);
  const sync = new MailSync(db, new GmailSync(db, key, provider, queue, sources), new ImapSync(db, key, queue, sources)); const calendarSync = new CalendarSync(db, key, provider, queue, calendarRepo);
  const hub = llm ?? new LlmHub(() => resolveAiConfig(config, new SettingsStore(db, config.SESSION_SECRET)));
  const aiProvider = ai ?? createAiProvider(hub, config); const suggestions = new SuggestionService(new PlanRepository(db, key), input=>new PlanAttentionService(db,key).record(input)); const extraction = new ExtractionService(db, key, aiProvider, () => backgroundAiEnabled(hub, config) ? hub.model('email') : undefined, () => new Date(), (input) => suggestions.ingest(input)); const actions = new CalendarActionService(db, key, queue, provider); const reminders = new ReminderService(db, key, createPushProvider(config)); const assistant = new AssistantService(db, key, () => hub.configured() && config.ASSISTANT_ENABLED !== 'false', new LlmAgent(hub)); const dailyOverview = new DailyOverviewService(db, key, createDailyOverviewProvider(hub, config), () => hub.model('main') ?? 'unconfigured'); const knowledgeMaintenance = new KnowledgeMaintenanceService(db, key, createKnowledgeMaintenanceProvider(hub, config), () => hub.model('main') ?? 'unconfigured'); return new Worker(queue, sync, db, new Scheduler(db, queue, sources), undefined, undefined, calendarSync, extraction, actions, reminders, assistant, new MorningDigestService(db, key, createPushProvider(config), config.PUSH_PROVIDER === 'webpush'), new ActivityNotificationService(db, key, createPushProvider(config), config.PUSH_PROVIDER === 'webpush'), dailyOverview, knowledgeMaintenance, new RelevanceTrialService(db,key,undefined,createTrialSummaryProvider(hub, config)));
}

if (process.argv[1]?.endsWith('/jobs/worker.ts') || process.argv[1]?.endsWith('/jobs/worker.js')) createWorker().start();
