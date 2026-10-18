import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import type { AiProvider, AiResponse } from '../providers/ai.js';
import { FakeAiProvider } from '../providers/ai.js';
import { JobQueue, type JobRecord } from '../jobs/queue.js';
import { BACKGROUND_AI_DAILY_LIMIT, BACKGROUND_AI_HOURLY_LIMIT, BackgroundAiService } from '../services/background-ai.js';
import { ExtractionService } from './extract.js';
import { KnowledgeRepository } from '../repos/knowledge.js';

const secret = keyFromSecret('extract-test-secret');
const now = new Date('2026-01-01T00:00:00.000Z');

function seed(text = 'School pickup at the library') {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 'subject-1', 'Alex', 'America/New_York', 1, now.toISOString());
  db.prepare('INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'm1', 'google-1', 'alex@example.test', '[]', '{}', 'active', 1, 'v1', now.toISOString(), now.toISOString(), now.toISOString());
  const evidence = { providerId: 'message-1', labels: ['INBOX'], sender: 'school@example.test', text, internalDate: now.toISOString(), attachmentsIncomplete: false };
  db.prepare('INSERT INTO source_items (id, household_id, owner_id, connection_id, kind, provider_key, encrypted_provider_refs, current_version_id, state, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('s1', 'h1', 'm1', 'c1', 'gmail_message', 'provider-key-1', '{}', 'v1', 'available', 1, now.toISOString(), now.toISOString());
  db.prepare('INSERT INTO source_versions (id, source_id, sequence, content_digest, encrypted_evidence, observed_at, original_at, expires_at, availability, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('v1', 's1', 1, 'digest-1', JSON.stringify(encryptJson(evidence, secret, 'source-version:v1')), now.toISOString(), now.toISOString(), '2026-01-08T00:00:00.000Z', 'available', '{}');
  db.prepare('INSERT INTO background_ai_settings VALUES (?, 1, ?, 1, ?)').run('m1', 'background-ai-v1', now.toISOString());
  return db;
}

function job(db: Database.Database, dedupeKey = 'extract:v1'): { queue: JobQueue; record: JobRecord } {
  const queue = new JobQueue(db, () => now);
  queue.enqueue({ kind: 'extract_source', scopeId: 'c1', dedupeKey, payload: { connectionId: 'c1', generation: 1, sourceVersionId: 'v1' } });
  return { queue, record: queue.claim(['extract_source'])! };
}

describe('source extraction', () => {
  it('skips queued non-Inbox evidence without a provider call or budget reservation', async () => {
    const db=seed(),provider=new FakeAiProvider();
    db.prepare('UPDATE source_versions SET encrypted_evidence=?').run(JSON.stringify(encryptJson({providerId:'message-1',labels:['SENT'],text:'School pickup',attachmentsIncomplete:false},secret,'source-version:v1')));
    await new ExtractionService(db,secret,provider,'synthetic-v1',()=>now).run(job(db).record);
    expect(provider.calls).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM background_ai_attempts').get()).toEqual({n:0});
    db.close();
  });
  it('passes bounded attachment media to the provider and validates media evidence', async () => {
    const db = seed();
    new KnowledgeRepository(db, secret, () => now).set({ memberId: 'm1', householdId: 'h1' }, { key: 'school_name', value: 'Maple Grove Elementary', expectedRevision: 0, confirmation: 'confirmed', provenance: 'user' });
    db.prepare('UPDATE source_versions SET encrypted_evidence = ? WHERE id = ?').run(JSON.stringify(encryptJson({ providerId: 'message-1', labels: ['INBOX'], sender: 'school@example.test', text: '', internalDate: now.toISOString(), attachmentsIncomplete: false, media: [{ kind: 'pdf', mimeType: 'application/pdf', dataBase64: 'JVBERi0xLjcK', pageCount: 1 }] }, secret, 'source-version:v1')), 'v1');
    const provider = new FakeAiProvider(); let seen: unknown;
    const original = provider.extract.bind(provider); provider.extract = async (packet, signal) => { seen = packet; return original(packet, signal); };
    const service = new ExtractionService(db, secret, provider, 'synthetic-v1', () => now);
    const { record } = job(db);
    expect(await service.run(record)).toEqual({ state: 'complete' });
    expect((seen as { media?: unknown[] }).media).toHaveLength(1);
    expect((seen as { knowledge?: Array<{ key: string; value: string }> }).knowledge).toEqual([{ key: 'school_name', value: 'Maple Grove Elementary', revision: 1, provenance: 'user', confirmation: 'confirmed', validity: 'current', validFrom: null, validUntil: null }]);
    expect(db.prepare('SELECT state FROM extractions').get()).toEqual({ state: 'succeeded' });
  });

  it('persists encrypted output and reuses a successful extraction', async () => {
    const db = seed();
    const provider = new FakeAiProvider();
    const service = new ExtractionService(db, secret, provider, 'synthetic-v1', () => now);
    const first = job(db);
    expect(await service.run(first.record)).toEqual({ state: 'complete' });
    first.queue.finish(first.record);
    expect(db.prepare('SELECT state, encrypted_result, usage_json FROM extractions').get()).toMatchObject({ state: 'succeeded', encrypted_result: expect.any(String), usage_json: expect.stringContaining('inputTokens') });
    const calls = provider.calls;
    const second = job(db, 'extract:v1:replay');
    expect(await service.run(second.record)).toEqual({ state: 'complete' });
    expect(provider.calls).toBe(calls);
  });

  it('does not reprocess retained sources solely because the prompt version changed', async () => {
    const db = seed();
    db.prepare(`INSERT INTO extractions (id, source_version_id, provider, model, prompt_version, policy_version, input_digest, state, encrypted_result, usage_json, expires_at, created_at, updated_at)
      VALUES ('old-extraction', 'v1', 'fake', 'synthetic-v1', 'extract-v3', 'privacy-v1', 'digest-1', 'succeeded', '{}', '{}', '2026-01-08T00:00:00.000Z', ?, ?)`)
      .run(now.toISOString(), now.toISOString());
    const provider = new FakeAiProvider(); const { record } = job(db);
    expect(await new ExtractionService(db, secret, provider, 'synthetic-v1', () => now).run(record)).toEqual({ state: 'complete' });
    expect(provider.calls).toBe(0);
    db.close();
  });

  it('records malformed provider output without creating shareable output', async () => {
    const db = seed();
    const malformed: AiProvider = { extract: async (): Promise<AiResponse> => ({ result: {} as AiResponse['result'], usage: {}, provider: 'fake', model: 'synthetic-v1' }), respondToChat: async () => { throw new Error('AI_CHAT_DISABLED'); } };
    const service = new ExtractionService(db, secret, malformed, 'synthetic-v1', () => now);
    const { record } = job(db);
    expect(await service.run(record)).toEqual({ state: 'complete' });
    expect(db.prepare('SELECT state, encrypted_result FROM extractions').get()).toEqual({ state: 'failed', encrypted_result: null });
  });

  it('drops an in-flight result when the connection generation changes', async () => {
    const db = seed();
    const provider = new FakeAiProvider();
    const originalExtract = provider.extract.bind(provider);
    provider.extract = async (packet, signal?: AbortSignal) => {
      const result = await originalExtract(packet, signal);
      db.prepare("UPDATE google_connections SET status = 'paused', generation = 2 WHERE id = 'c1'").run();
      return result;
    };
    const service = new ExtractionService(db, secret, provider, 'synthetic-v1', () => now);
    const { record } = job(db);
    expect(await service.run(record)).toEqual({ state: 'complete' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM extractions').get()).toEqual({ count: 0 });
  });
});

describe('background processing privacy and limits', () => {
  it.each([
    "DELETE FROM background_ai_settings",
    "UPDATE background_ai_settings SET enabled = 0",
    "UPDATE members SET active = 0",
    "UPDATE source_versions SET expires_at = '2025-12-31T00:00:00.000Z'",
    "UPDATE google_connections SET generation = 2",
  ])('does not send source content when authorization is invalid: %s', async (sql) => {
    const db = seed(); db.exec(sql); const provider = new FakeAiProvider();
    await new ExtractionService(db, secret, provider, 'synthetic-v1', () => now).run(job(db).record);
    expect(provider.calls).toBe(0);
  });
  it.each([
    "UPDATE members SET active = 0",
    "UPDATE background_ai_settings SET enabled = 0",
    "UPDATE background_ai_settings SET revision = revision + 2",
    "UPDATE source_versions SET availability = 'expired'",
  ])('drops in-flight results after a privacy transition: %s', async (sql) => {
    const db = seed(); const provider = new FakeAiProvider(); const original = provider.extract.bind(provider);
    provider.extract = async (packet, signal) => { const result = await original(packet, signal); db.exec(sql); return result; };
    let shared = false;
    await new ExtractionService(db, secret, provider, 'synthetic-v1', () => now, () => { shared = true; }).run(job(db).record);
    expect(shared).toBe(false); expect(db.prepare('SELECT count(*) AS n FROM extractions').get()).toEqual({ n: 0 });
  });
  it('skips recognized sender exclusions before AI, including display-name email headers', async () => {
    const db = seed(); db.prepare("INSERT INTO source_policies (member_id, excluded_senders_json, excluded_labels_json, updated_at) VALUES (?, ?, '[]', ?)").run('m1', '["school@example.test"]', now.toISOString());
    db.prepare('UPDATE source_versions SET encrypted_evidence = ?').run(JSON.stringify(encryptJson({ providerId: 'message-1', labels: ['INBOX'], sender: 'School <school@example.test>', text: 'School event', attachmentsIncomplete: false }, secret, 'source-version:v1')));
    const provider = new FakeAiProvider();
    await new ExtractionService(db, secret, provider, 'synthetic-v1', () => now).run(job(db).record);
    expect(provider.calls).toBe(0);
  });
  it('bounds actual provider retries across jobs and records exhaustion', async () => {
    const db = seed(); let calls = 0;
    const provider: AiProvider = { extract: async () => { calls++; throw new Error('AI_RETRYABLE'); }, respondToChat: async () => { throw new Error('UNUSED'); } };
    const service = new ExtractionService(db, secret, provider, 'test', () => now);
    for (let i = 0; i < 4; i++) { const j = job(db, `retry:${i}`); await service.run(j.record); j.queue.finish(j.record); }
    expect(calls).toBe(3);
    expect(db.prepare('SELECT error_code FROM extractions').get()).toEqual({ error_code: 'AI_RETRY_LIMIT' });
  });
});

 it('persists hourly and daily attempt limits across service restarts', () => {
    const db = seed(); let at = new Date(now); const clock = () => at;
    const clone = db.prepare(`INSERT INTO source_versions (id, source_id, sequence, content_digest, encrypted_evidence, observed_at, original_at, expires_at, availability, metadata_json)
      SELECT ?, source_id, ?, content_digest || ?, encrypted_evidence, observed_at, original_at, expires_at, availability, metadata_json FROM source_versions WHERE id = 'v1'`);
    for (let i = 0; i <= BACKGROUND_AI_DAILY_LIMIT; i++) clone.run(`quota-${i}`, i + 2, `quota-${i}`);
    for (let hour = 0; hour < BACKGROUND_AI_DAILY_LIMIT / BACKGROUND_AI_HOURLY_LIMIT; hour++) {
      for (let item = 0; item < BACKGROUND_AI_HOURLY_LIMIT; item++) expect(new BackgroundAiService(db, true, clock).reserve('m1', `quota-${hour * BACKGROUND_AI_HOURLY_LIMIT + item}`, 'test')).toBe('reserved');
      expect(new BackgroundAiService(db, true, clock).status({ memberId: 'm1', householdId: 'h1' })).toMatchObject({ volumeWarning: true, pausedForVolume: true });
      expect(new BackgroundAiService(db, true, clock).reserve('m1', `quota-${BACKGROUND_AI_DAILY_LIMIT}`, 'test')).toBe('capacity');
      at = new Date(at.getTime() + 3600000);
    }
    expect(new BackgroundAiService(db, true, clock).reserve('m1', `quota-${BACKGROUND_AI_DAILY_LIMIT}`, 'test')).toBe('capacity');
    at = new Date(at.getTime() + 86400000);
    expect(new BackgroundAiService(db, true, clock).status({ memberId: 'm1', householdId: 'h1' })).toMatchObject({ volumeWarning: false, pausedForVolume: false });
    expect(new BackgroundAiService(db, true, clock).reserve('m1', `quota-${BACKGROUND_AI_DAILY_LIMIT}`, 'test')).toBe('reserved');
  });

it('enabling queues retained Gmail sources while toggling leaves Google sync alone', () => {
  const db = seed(); const background = new BackgroundAiService(db, true, () => now);
  const actor = { memberId: 'm1', householdId: 'h1' }; const pending = job(db);
  const sync = pending.queue.enqueue({ kind: 'gmail_sync', scopeId: 'c1', dedupeKey: 'sync', payload: { connectionId: 'c1', generation: 1 } });
  background.set(actor, false, 1);
  expect(pending.queue.get(pending.record.id)?.state).toBe('canceled');
  expect(pending.queue.get(sync.id)?.state).toBe('ready');
  expect(background.set(actor, true, 2).pending).toBe(1);
  expect(pending.queue.claim(['extract_source'])?.payload.sourceVersionId).toBe('v1');
});

it('continues past the old daily cap and warns before pausing, scoped to the owner', () => {
  const db = seed();
  const service = new BackgroundAiService(db, true, () => now);
  const insert = db.prepare("INSERT INTO background_ai_attempts VALUES (?, 'm1', 'v1', 'test', ?)");
  for (let i=0; i<249; i++) insert.run(`usage-${i}`, now.toISOString());
  const actor = { memberId: 'm1', householdId: 'h1' };
  expect(service.status(actor)).toMatchObject({ volumeWarning: false, pausedForVolume: false });
  // A distinct model keeps this reservation separate from the source retry ceiling.
  expect(service.reserve('m1', 'v1', 'other-model')).toBe('reserved');
  expect(service.status(actor)).toMatchObject({ attemptsLastHour: 250, volumeWarning: true, pausedForVolume: false });
  db.prepare("INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES ('m2','h1','other','Other','America/New_York',1,?)").run(now.toISOString());
  expect(service.status({ memberId: 'm2', householdId: 'h1' })).toMatchObject({ attemptsLastDay: 0, volumeWarning: false });
});

it('reserves the stronger model separately and rechecks consent before review',async()=>{
 const db=seed();const fake=new FakeAiProvider();
 const provider: AiProvider={extract:async(packet,signal,before)=>{before?.('review-model');return fake.extract(packet,signal);},respondToChat:async()=>{throw Error('UNUSED');}};
 await new ExtractionService(db,secret,provider,'synthetic-v1',()=>now).run(job(db).record);
 expect(db.prepare('SELECT model FROM background_ai_attempts ORDER BY model').all()).toEqual([{model:'review-model'},{model:'synthetic-v1'}]);db.close();
 const revoked=seed();const blocked: AiProvider={...provider,extract:async(packet,signal,before)=>{revoked.prepare('UPDATE background_ai_settings SET enabled=0').run();before?.('review-model');return fake.extract(packet,signal);}};
 await new ExtractionService(revoked,secret,blocked,'synthetic-v1',()=>now).run(job(revoked).record);
 expect(revoked.prepare('SELECT count(*) n FROM extractions').get()).toEqual({n:0});expect(revoked.prepare('SELECT count(*) n FROM background_ai_attempts').get()).toEqual({n:1});revoked.close();
});

it('persists completed gates across workers and capacity waits without exhausting Luna',async()=>{
 const db=seed(),fake=new FakeAiProvider();let gateCalls=0,reviewCalls=0;
 const provider:AiProvider={managesReservations:true,extract:async(packet,signal,before,store)=>{
  if(!store?.load('same-source')){before?.('synthetic-v1');gateCalls++;store?.save('same-source',{reviewReason:'review',usage:{model:'synthetic-v1',inputTokens:10,outputTokens:10,reasoningTokens:0,providerRequestId:'gate'}});}
  before?.('review-model');reviewCalls++;return fake.extract(packet,signal);
 },respondToChat:async()=>{throw Error('UNUSED')}};
 const record=job(db).record;
 const insert=db.prepare("INSERT INTO background_ai_attempts VALUES (?, 'm1','v1','filler',?)");
 for(let i=0;i<499;i++)insert.run('fill-'+i,now.toISOString());
 for(let retry=0;retry<4;retry++)expect(await new ExtractionService(db,secret,provider,'synthetic-v1',()=>now).run(record)).toMatchObject({state:'retry',retryKind:'capacity'});
 expect(gateCalls).toBe(1);expect(reviewCalls).toBe(0);
 expect(db.prepare('SELECT encrypted_checkpoint FROM email_gate_checkpoints').get()).not.toEqual(expect.objectContaining({encrypted_checkpoint:expect.stringContaining('reviewReason')}));
 db.prepare("DELETE FROM background_ai_attempts WHERE model='filler'").run();
 expect(await new ExtractionService(db,secret,provider,'synthetic-v1',()=>now).run(record)).toEqual({state:'complete'});
 expect(gateCalls).toBe(1);expect(reviewCalls).toBe(1);expect(db.prepare('SELECT state FROM extractions').get()).toEqual({state:'succeeded'});
 db.prepare("UPDATE source_versions SET availability='expired',encrypted_evidence='' WHERE id='v1'").run();
 expect(db.prepare('SELECT count(*) n FROM email_gate_checkpoints').get()).toEqual({n:0});db.close();
});
