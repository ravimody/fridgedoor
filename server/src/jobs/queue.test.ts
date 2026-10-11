import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { JobQueue } from './queue.js';

describe('durable job leases', () => {
  let db: Database.Database; let now: Date;
  beforeEach(() => { db = new Database(':memory:'); migrate(db); now = new Date('2026-01-01T00:00:00.000Z'); });
  it('allows only one worker to claim a ready job and rejects a stale finish', () => {
    const one = new JobQueue(db, () => now, 1000); const two = new JobQueue(db, () => now, 1000);
    one.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'sync:1', payload: { connectionId: 'c1', generation: 1 } });
    const first = one.claim(['gmail_sync'])!; expect(two.claim(['gmail_sync'])).toBeUndefined();
    now = new Date(now.getTime() + 1001); two.recoverExpired(); expect(two.claim(['gmail_sync'])?.id).toBe(first.id); expect(one.finish(first)).toBe(false);
  });
  it('recovers expired work and leaves disabled handlers queued', () => {
    const queue = new JobQueue(db, () => now, 1000);
    queue.enqueue({ kind: 'extract_source', scopeId: 'c1', dedupeKey: 'extract:1', payload: { sourceVersionId: 'v1' } });
    queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'sync:1', payload: { connectionId: 'c1', generation: 1 } });
    expect(queue.claim(['gmail_sync'])?.kind).toBe('gmail_sync');
    now = new Date(now.getTime() + 1001); queue.recoverExpired();
    expect(queue.getByDedupe('extract:1')?.state).toBe('ready');
  });
  it('deduplicates scheduled buckets', () => {
    const queue = new JobQueue(db, () => now); queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'bucket', payload: { connectionId: 'c1', generation: 1 } });
    const second = queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'bucket', payload: { connectionId: 'c1', generation: 1 }, runAfter: new Date(now.getTime() + 1000) });
    expect(second.id).toBe(queue.getByDedupe('bucket')?.id); expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
  });
  it('prioritizes the existing morning push over low-priority overview generation', () => {
    const queue = new JobQueue(db, () => now);
    queue.enqueue({ kind: 'daily_overview', scopeId: 'daily:m1', dedupeKey: 'daily', payload: {}, runAfter: new Date(now.getTime() - 1000) });
    queue.enqueue({ kind: 'morning_digest', scopeId: 'system', dedupeKey: 'digest', payload: {}, runAfter: new Date(now.getTime() - 1000) });
    expect(queue.claim(['daily_overview', 'morning_digest'])?.kind).toBe('morning_digest');
  });
});
it('prepares the morning review ahead of an older email extraction backlog',()=>{
  const db=new Database(':memory:');migrate(db);const now=new Date('2026-09-20T10:50:00Z'),queue=new JobQueue(db,()=>now);
  queue.enqueue({kind:'extract_source',scopeId:'mail',dedupeKey:'old-mail',payload:{},runAfter:new Date(now.getTime()-3600000)});
  queue.enqueue({kind:'daily_overview',scopeId:'daily:owner',dedupeKey:'morning',payload:{}});
  expect(queue.claim(['extract_source','daily_overview'])?.kind).toBe('daily_overview');db.close();
});
