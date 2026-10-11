import type { ActivityNotificationService } from '../services/activity-notifications.js';
import type { ReminderService } from '../services/reminders.js';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.js';
import type { GmailSync } from '../sync/gmail.js';
import { JobQueue } from './queue.js';
import { Worker } from './worker.js';
import { keyFromSecret } from '../crypto.js';
import { FakeDailyOverviewProvider } from '../ai/daily-overview.js';
import { DailyOverviewService } from '../services/daily-overview.js';
import { KnowledgeRepository } from '../repos/knowledge.js';
import { FakeKnowledgeMaintenanceProvider } from '../ai/knowledge-maintenance.js';
import { KnowledgeMaintenanceService } from '../services/knowledge-maintenance.js';
import { ExtractionService } from '../ai/extract.js';
import { AssistantService } from '../ai/assistant-service.js';
import { FakeAiProvider } from '../providers/ai.js';

describe('worker dispatch', () => {
  let db: Database.Database; let queue: JobQueue;
  beforeEach(() => { db = new Database(':memory:'); migrate(db); queue = new JobQueue(db, () => new Date('2026-01-01T00:00:00.000Z')); });
  it('finishes registered work and leaves extraction queued until its handler exists', async () => {
    const sync = { run: vi.fn().mockResolvedValue({ state: 'complete' }) } as unknown as GmailSync;
    const worker = new Worker(queue, sync, db, undefined, () => new Date('2026-01-01T00:00:00.000Z'), () => undefined);
    queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'sync:1', payload: { connectionId: 'c1', generation: 1 } });
    queue.enqueue({ kind: 'extract_source', scopeId: 'c1', dedupeKey: 'extract:1', payload: { sourceVersionId: 'v1' } });
    expect(await worker.runOnce()).toBe(true); expect(sync.run).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT state FROM jobs WHERE kind = 'gmail_sync'").get()).toEqual({ state: 'succeeded' });
    expect(db.prepare("SELECT state FROM jobs WHERE kind = 'extract_source'").get()).toEqual({ state: 'ready' });
    expect(db.prepare("SELECT id FROM worker_health WHERE id = 'planner-worker'").get()).toEqual({ id: 'planner-worker' });
  });
});
it('runs activity delivery on the existing reminder tick',async()=>{
  const db=new Database(':memory:');migrate(db);const queue=new JobQueue(db);const activity={deliverDue:vi.fn().mockResolvedValue({sent:0})};
  const worker=new Worker(queue,{} as GmailSync,db,undefined,undefined,()=>undefined,undefined,undefined,undefined,{deliverDue:vi.fn().mockResolvedValue(undefined)} as unknown as ReminderService,undefined,undefined,activity as unknown as ActivityNotificationService);
  queue.enqueue({kind:'reminder_delivery',scopeId:'system',dedupeKey:'tick',payload:{}});await worker.runOnce();expect(activity.deliverDue).toHaveBeenCalledOnce();
});

it('runs a scheduled overview through the leased worker job', async () => {
  const db = new Database(':memory:'); migrate(db); const now = new Date('2026-01-01T12:02:00.000Z');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', 1, now.toISOString());
  db.prepare('INSERT INTO daily_ai_settings VALUES (?, 1, ?, 1, ?)').run('m1', 'daily-assistant-v1', now.toISOString());
  const queue = new JobQueue(db, () => now); const provider = new FakeDailyOverviewProvider(); const service = new DailyOverviewService(db, keyFromSecret('worker-daily-test'), provider, 'synthetic', () => now);
  queue.enqueue({ kind: 'daily_overview', scopeId: 'daily:m1', dedupeKey: 'daily-job', payload: { ownerId: 'm1', householdId: 'h1', localDate: '2026-01-01', timezone: 'America/New_York', consentRevision: 1, logicalRequest: 'daily-job' } });
  const worker = new Worker(queue, {} as GmailSync, db, undefined, () => now, () => undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
  expect(await worker.runOnce()).toBe(true);
  expect(db.prepare("SELECT state FROM jobs WHERE kind = 'daily_overview'").get()).toEqual({ state: 'succeeded' });
  expect(provider.calls).toBe(1);
  db.close();
});

it('expires knowledge history and archived values during retention', async () => {
  const now = new Date('2026-02-01T12:00:00.000Z');
  const db = new Database(':memory:'); migrate(db);
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', now.toISOString());
  const key = keyFromSecret('worker-knowledge-test');
  new KnowledgeRepository(db, key, () => now).set({ memberId: 'm1', householdId: 'h1' }, { key: 'school', value: 'Old', expectedRevision: 0 });
  db.prepare("UPDATE assistant_knowledge SET archived_at = '2025-12-01T00:00:00.000Z'").run();
  db.prepare("UPDATE knowledge_changes SET undo_until = '2025-12-01T00:00:00.000Z'").run();
  const queue = new JobQueue(db, () => now);
  queue.enqueue({ kind: 'retention', scopeId: 'system', dedupeKey: 'retention-test', payload: {} });
  const worker = new Worker(queue, {} as GmailSync, db, undefined, () => now, () => undefined);
  await worker.runOnce();
  expect(db.prepare('SELECT count(*) AS count FROM assistant_knowledge').get()).toEqual({ count: 0 });
  expect(db.prepare('SELECT count(*) AS count FROM knowledge_changes').get()).toEqual({ count: 0 });
  db.close();
});

it('runs a scheduled maintenance job through the leased worker', async () => {
  const now = new Date('2026-02-01T12:00:00.000Z'); const db = new Database(':memory:'); migrate(db);
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', now.toISOString());
  const provider = new FakeKnowledgeMaintenanceProvider(); const service = new KnowledgeMaintenanceService(db, keyFromSecret('worker-maintenance-test'), provider, 'synthetic', () => now); const queue = new JobQueue(db, () => now);
  queue.enqueue({ kind: 'daily_maintenance', scopeId: 'daily:m1', dedupeKey: 'maintenance-job', payload: { ownerId: 'm1', householdId: 'h1', localDate: '2026-02-01', timezone: 'America/New_York', consentRevision: 1, logicalRequest: 'maintenance-job' } });
  const worker = new Worker(queue, {} as GmailSync, db, undefined, () => now, () => undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
  expect(await worker.runOnce()).toBe(true); expect(provider.calls).toBe(0); expect(db.prepare("SELECT state FROM jobs WHERE kind = 'daily_maintenance'").get()).toEqual({ state: 'succeeded' });
  db.close();
});

it('records a failed overview as a failed job instead of reporting success', async () => {
  const db=new Database(':memory:');migrate(db);const queue=new JobQueue(db);
  const service={generate:vi.fn().mockResolvedValue({state:'unavailable',errorCode:'AI_RETRYABLE'})} as unknown as DailyOverviewService;
  const worker=new Worker(queue,{} as GmailSync,db,undefined,undefined,()=>undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,service);
  queue.enqueue({kind:'daily_overview',scopeId:'daily:m1',dedupeKey:'failed-review',payload:{ownerId:'m1',householdId:'h1',localDate:'2026-09-19',timezone:'America/New_York',consentRevision:1}});
  await worker.runOnce();
  expect(db.prepare("SELECT state,error_code FROM jobs WHERE dedupe_key='failed-review'").get()).toEqual({state:'failed',error_code:'AI_RETRYABLE'});
  db.close();
});
it('bounds unexpected handler retries and logs only safe error codes',async()=>{
  const db=new Database(':memory:');migrate(db);let now=new Date('2026-09-19T11:00:00Z');const clock=()=>now,queue=new JobQueue(db,clock),log=vi.fn();
  queue.enqueue({kind:'gmail_sync',scopeId:'test',dedupeKey:'unexpected-error',payload:{}});
  const worker=new Worker(queue,{run:async()=>{throw new Error('Private source content must not be logged');}} as unknown as GmailSync,db,undefined,clock,log);
  for(let attempt=0;attempt<6;attempt++){await worker.runOnce();now=new Date(now.getTime()+31000);}
  expect(queue.getByDedupe('unexpected-error')).toMatchObject({state:'failed',attemptCount:6,errorCode:'WORKER_FAILED'});expect(JSON.stringify(log.mock.calls)).not.toContain('Private source content');db.close();
});

it('claims extraction and assistant jobs only while AI is available', async () => {
  const db=new Database(':memory:');migrate(db);const now=new Date('2026-09-19T11:00:00Z');const queue=new JobQueue(db,()=>now);const ai:{model?:string;enabled:boolean}={enabled:false};
  const extraction=new ExtractionService(db,keyFromSecret('worker-ai-test'),new FakeAiProvider(),()=>ai.model,()=>now);
  const run=vi.spyOn(extraction,'run').mockResolvedValue({state:'complete'});
  const assistant=new AssistantService(db,keyFromSecret('worker-ai-test'),()=>ai.enabled,undefined,()=>now);
  const dispatch=vi.spyOn(assistant,'dispatchCapture').mockReturnValue(undefined);
  queue.enqueue({kind:'extract_source',scopeId:'c1',dedupeKey:'extract',payload:{sourceVersionId:'v1',generation:1}});
  queue.enqueue({kind:'capture_dispatch',scopeId:'capture:m1',dedupeKey:'capture',payload:{captureId:'c1'}});
  const worker=new Worker(queue,{} as GmailSync,db,undefined,()=>now,()=>undefined,undefined,extraction,undefined,undefined,assistant);
  expect(await worker.runOnce()).toBe(false);
  ai.model='email-model';ai.enabled=true;
  expect(await worker.runOnce()).toBe(true);expect(await worker.runOnce()).toBe(true);
  expect(run).toHaveBeenCalledOnce();expect(dispatch).toHaveBeenCalledOnce();
  db.close();
});
