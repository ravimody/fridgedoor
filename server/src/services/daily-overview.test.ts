import { JobQueue } from '../jobs/queue.js';
import { FakeDailyOverviewProvider } from '../ai/daily-overview.js';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { PlanRepository } from '../repos/plans.js';
import { DAILY_OVERVIEW_PROMPT_VERSION, DailyOverviewProviderError, type DailyOverviewProvider, type DailyOverviewResponse } from '../ai/daily-overview.js';
import { AiUsageLedger, AiUsageLimitError } from './ai-usage.js';
import { DAILY_AI_CONSENT, DailyOverviewService } from './daily-overview.js';
import { DailyContextService } from './daily-context.js';
import { ClarificationService } from './clarifications.js';

const now = new Date('2026-03-08T16:00:00.000Z');
const key = keyFromSecret('daily-overview-test');
const actor = { memberId: 'm1', householdId: 'h1' };

function seed() {
  const db = new Database(':memory:'); migrate(db);
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', 1, now.toISOString());
  db.prepare('INSERT INTO daily_ai_settings VALUES (?, 1, ?, 1, ?)').run('m1', DAILY_AI_CONSENT, now.toISOString());
  return db;
}

function addPlan(db: Database.Database) {
  return new PlanRepository(db, key, () => now).createPrivate(actor, { title: 'Synthetic deadline', category: 'school', participants: [], time: { kind: 'deadline', at: '2026-03-08T23:00:00-04:00', timezone: 'America/New_York' }, preparationTasks: [], unresolvedFields: [] });
}

function providerFor(factory: (context: Parameters<DailyOverviewProvider['generate']>[0]) => DailyOverviewResponse | Promise<DailyOverviewResponse>): DailyOverviewProvider {
  return { generate: vi.fn(async (context) => factory(context)) };
}

describe('daily overview service', () => {
  it('validates refs, stores encrypted sourced output, and serves the current revision', async () => {
    const db = seed(); addPlan(db);
    const provider = providerFor((context) => ({ result: { summary: 'Synthetic result', items: [{ refs: [context.candidates[0]!.ref], category: 'deadline', headline: 'Deadline', detail: 'Synthetic detail', priority: 'important' }], questions: [{ refs: [context.candidates[0]!.ref], text: 'Who will handle this?', reason: 'The owner is not established.' }], omittedRefs: [] }, usage: { inputTokens: 12, outputTokens: 9, providerRequestId: 'response-1' }, provider: 'fake', model: 'synthetic' }));
    const service = new DailyOverviewService(db, key, provider, 'synthetic', () => now);
    const generated = await service.generate(actor, 'request-1');
    expect(generated.state).toBe('ready');
    expect(generated.result.items[0]?.refs[0]).toMatch(/^candidate-/);
    expect(db.prepare('SELECT state, encrypted_result, encrypted_source_manifest FROM daily_overviews').get()).toMatchObject({ state: 'ready' });
    const stored = db.prepare('SELECT encrypted_result FROM daily_overviews').get() as { encrypted_result: string };
    expect(stored.encrypted_result).not.toContain('Synthetic result');
    expect(service.read(actor)).toMatchObject({ state: 'ready', result: generated.result });
    expect(db.prepare('SELECT outcome, input_tokens, output_tokens FROM ai_usage_attempts').get()).toEqual({ outcome: 'response_received', input_tokens: 12, output_tokens: 9 });
    const clarifications = new ClarificationService(db, key, () => now);
    const pending = clarifications.list(actor);
    expect(pending).toHaveLength(1);
    expect(clarifications.answer(actor, pending[0]!.id, 'I will handle it.', pending[0]!.revision)).toMatchObject({ state: 'answered', answer: 'I will handle it.' });
    expect(() => clarifications.dismiss(actor, pending[0]!.id, pending[0]!.revision)).toThrow('STALE_REVISION');
    db.close();
  });

  it('retires a decision once its event has started', async () => {
    const db = seed();
    new PlanRepository(db, key, () => now).createPrivate(actor, { title: 'Synthetic campout', category: 'activity', participants: [], time: { kind: 'timed', start: '2026-03-09T18:00:00-04:00', end: '2026-03-10T10:00:00-04:00', timezone: 'America/New_York' }, preparationTasks: [], unresolvedFields: [] });
    const provider = providerFor((context) => ({ result: { summary: 'Synthetic result', items: [], questions: [{ refs: [context.candidates[0]!.ref], text: 'Does the organizer need a meal note?', reason: 'Synthetic reason.' }], omittedRefs: [] }, usage: { inputTokens: 1, outputTokens: 1 }, provider: 'fake', model: 'synthetic' }));
    await new DailyOverviewService(db, key, provider, 'synthetic', () => now).generate(actor, 'request-event');
    expect(new ClarificationService(db, key, () => now).list(actor)).toHaveLength(1);
    expect(new ClarificationService(db, key, () => new Date('2026-03-09T22:30:00.000Z')).list(actor)).toEqual([]);
    expect(db.prepare('SELECT state FROM clarifications').get()).toEqual({ state: 'expired' });
    db.close();
  });

  it('reports unavailable without substitute items and records usage for malformed and unknown model output', async () => {
    for (const result of [{ summary: 'missing fields' }, { summary: 'bad ref', items: [{ refs: ['unknown'], category: 'today', headline: 'Bad', detail: '', priority: 'routine' }], questions: [], omittedRefs: [] }]) {
      const db = seed(); addPlan(db);
      const provider = providerFor(() => ({ result, usage: { inputTokens: 41, outputTokens: 17 }, provider: 'fake', model: 'synthetic' }));
      const service = new DailyOverviewService(db, key, provider, 'synthetic', () => now);
      const output = await service.generate(actor, `request-${JSON.stringify(result)}`);
      expect(output.state).toBe('unavailable');
      expect(db.prepare('SELECT state, error_code FROM daily_overviews').get()).toMatchObject({ state: 'failed' });
      expect(db.prepare('SELECT outcome, input_tokens, output_tokens FROM ai_usage_attempts').get()).toEqual({ outcome: 'rejected', input_tokens: 41, output_tokens: 17 });
      db.close();
    }
  });

  it('records provider failures and preserves unknown usage as NULL', async () => {
    const db = seed(); addPlan(db);
    const provider: DailyOverviewProvider = { generate: vi.fn(async () => { throw new DailyOverviewProviderError('AI_RETRYABLE', { provider: 'fake', model: 'synthetic', usage: { inputTokens: 33, outputTokens: 4 } }); }) };
    const service = new DailyOverviewService(db, key, provider, 'synthetic', () => now);
    expect((await service.generate(actor, 'failure')).state).toBe('unavailable');
    expect(db.prepare('SELECT outcome, input_tokens, output_tokens, cached_read_tokens FROM ai_usage_attempts').get()).toEqual({ outcome: 'AI_RETRYABLE', input_tokens: 33, output_tokens: 4, cached_read_tokens: null });
    db.close();
  });

  it('cancels a provider that exceeds the bounded timeout', async () => {
    vi.useFakeTimers();
    try {
      const db = seed(); addPlan(db);
      const provider: DailyOverviewProvider = { generate: vi.fn(async (_context, signal) => await new Promise<DailyOverviewResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DailyOverviewProviderError('AI_CANCELLED')));
      })) };
      const service = new DailyOverviewService(db, key, provider, 'synthetic', () => now);
      const pending = service.generate(actor, 'timeout');
      await vi.advanceTimersByTimeAsync(45_000);
      expect((await pending)).toMatchObject({ state: 'unavailable', errorCode: 'AI_CANCELLED' });
      expect(db.prepare('SELECT state, error_code FROM daily_overviews').get()).toMatchObject({ state: 'failed', error_code: 'AI_CANCELLED' });
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates a response when consent, the reference date, or source facts change while it runs', async () => {
    for (const change of ['consent', 'midnight', 'fact']) {
      const db = seed(); const planId = addPlan(db);
      let clock = now;
      const serviceRef: { current?: DailyOverviewService } = {};
      const provider = providerFor((context) => {
        if (change === 'consent') serviceRef.current!.setSettings(actor, { enabled: false, expectedRevision: 1 });
        if (change === 'midnight') clock = new Date('2026-03-09T16:00:00.000Z');
        if (change === 'fact') db.prepare('DELETE FROM plans WHERE id = ?').run(planId);
        return { result: { summary: 'stale', items: [{ refs: [context.candidates[0]!.ref], category: 'deadline', headline: 'Stale', detail: '', priority: 'important' }], questions: [], omittedRefs: [] }, usage: { inputTokens: 5 }, provider: 'fake', model: 'synthetic' };
      });
      const service = new DailyOverviewService(db, key, provider, 'synthetic', () => clock);
      serviceRef.current = service;
      const output = await service.generate(actor, change);
      expect(output.state).toBe('unavailable');
      expect(db.prepare('SELECT state, encrypted_result, error_code FROM daily_overviews').get()).toMatchObject({ state: 'failed', encrypted_result: null, error_code: change === 'consent' ? 'AI_DISABLED' : 'DAILY_OVERVIEW_STALE' });
      expect(db.prepare('SELECT outcome FROM ai_usage_attempts').get()).toEqual({ outcome: 'invalidated' });
      db.close();
    }
  });

  it('does not publish after the owner is disabled and enforces the per-day ledger cap transactionally', async () => {
    const db = seed(); addPlan(db);
    const provider = providerFor((context) => { db.prepare('UPDATE members SET active = 0').run(); return { result: { summary: 'stale', items: [{ refs: [context.candidates[0]!.ref], category: 'deadline', headline: 'Stale', detail: '', priority: 'important' }], questions: [], omittedRefs: [] }, usage: {}, provider: 'fake', model: 'synthetic' }; });
    const service = new DailyOverviewService(db, key, provider, 'synthetic', () => now);
    expect((await service.generate(actor, 'disabled')).state).toBe('unavailable');
    expect(db.prepare('SELECT state, error_code FROM daily_overviews').get()).toMatchObject({ state: 'failed', error_code: 'DAILY_OVERVIEW_STALE' });
    db.close();
    const capDb = seed();
    const ledger = new AiUsageLedger(capDb, () => now);
    for (let attempt = 0; attempt < 12; attempt++) ledger.reserve({ ownerId: 'm1', feature: 'daily_overview', logicalRequest: `cap-${attempt}`, localDate: '2026-03-08', timezone: 'America/New_York', model: 'synthetic', promptVersion: DAILY_OVERVIEW_PROMPT_VERSION });
    expect(() => ledger.reserve({ ownerId: 'm1', feature: 'daily_overview', logicalRequest: 'cap-13', localDate: '2026-03-08', timezone: 'America/New_York', model: 'synthetic', promptVersion: DAILY_OVERVIEW_PROMPT_VERSION })).toThrow(AiUsageLimitError);
    capDb.close();
  });
});

it('dismisses only this member’s exact morning item, persists through regeneration, and preserves plans', async()=>{
  const db=seed();const id=addPlan(db);
  db.prepare('INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES (?,?,?,?,?,1,?)').run('m2','h1','s2','Other','America/New_York',now.toISOString());
  const repo=new PlanRepository(db,key,()=>now), original=repo.detail(id,actor.memberId);
  repo.share(id,actor.memberId,original.revision,original.facts);
  const provider=providerFor(context=>({result:{summary:'One item',items:context.candidates.map(c=>({refs:[c.ref],category:'deadline',headline:c.title,detail:'Decision due',priority:'important'})),questions:[],omittedRefs:[]},usage:{},provider:'fake',model:'synthetic'}));
  const service=new DailyOverviewService(db,key,provider,'synthetic',()=>now);
  const before=await service.generate(actor,'before-dismiss');
  expect(()=>service.dismiss(actor,before.items[0]!.refs,before.revision+1)).toThrow('STALE_REVISION');
  expect(()=>service.dismiss(actor,['unknown'],before.revision)).toThrow('NOT_FOUND');
  const planBefore=repo.detail(id,actor.memberId);
  expect(service.dismiss(actor,before.items[0]!.refs,before.revision).items).toEqual([]);
  expect(service.read(actor).items).toEqual([]);
  expect((await service.generate(actor,'after-dismiss')).items).toEqual([]);
  expect(repo.detail(id,actor.memberId)).toEqual(planBefore);
  expect(service.read({memberId:'m2',householdId:'h1'}).items).toHaveLength(1);
  const tomorrow=new DailyOverviewService(db,key,provider,'synthetic',()=>new Date(now.getTime()+86400000));
  expect(tomorrow.read(actor).items).toEqual([]);
  repo.edit(id,actor.memberId,planBefore.revision,{...planBefore.facts,notes:'Bring a newly required document'});
  expect(new DailyContextService(db,key,()=>new Date(now.getTime()+86400000)).build(actor).candidates).toHaveLength(1);
  db.close();
});

it('reports unavailable rather than letting the model omit a required deadline',async()=>{
  const db=seed();addPlan(db);
  const provider=providerFor(()=>({result:{summary:'Nothing to do',items:[],questions:[],omittedRefs:[]},usage:{},provider:'fake',model:'synthetic'}));
  const view=await new DailyOverviewService(db,key,provider,'synthetic',()=>now).generate(actor,'missing-deadline');
  expect(view).toMatchObject({state:'unavailable',errorCode:'DAILY_OVERVIEW_MISSING_REQUIRED'});
  expect(view.items).toEqual([]);expect(view.result.summary).not.toContain('Nothing to do');db.close();
});

it('allows an unreviewed extracted deadline to be omitted without discarding a valid review',async()=>{
  const db=seed();const id=addPlan(db);
  db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(id);
  const provider=providerFor(()=>({result:{summary:'No meaningful action today',items:[],questions:[],omittedRefs:[]},usage:{},provider:'fake',model:'synthetic'}));
  const service=new DailyOverviewService(db,key,provider,'synthetic',()=>now);
  expect((await service.generate(actor,'unreviewed-deadline')).state).toBe('ready');
  expect(service.read(actor).state).toBe('ready');
  expect(new PlanRepository(db,key,()=>now).detail(id,actor.memberId)).toBeDefined();db.close();
});

it('invalidates a cached review when a new required commitment appears', async () => {
  const db=seed();addPlan(db);
  const provider=providerFor(context=>({result:{summary:'Current review',items:context.candidates.map(c=>({refs:[c.ref],category:'today',headline:c.title,detail:'Due today',priority:'important'})),questions:[],omittedRefs:[]},usage:{},provider:'fake',model:'synthetic'}));
  const service=new DailyOverviewService(db,key,provider,'synthetic',()=>now);
  expect((await service.generate(actor,'initial')).state).toBe('ready');
  new PlanRepository(db,key,()=>now).createPrivate(actor,{title:'New required deadline',category:'school',participants:[],time:{kind:'deadline',at:'2026-03-08T22:00:00-04:00',timezone:'America/New_York'},preparationTasks:[],unresolvedFields:[]});
  expect(service.read(actor)).toMatchObject({state:'unavailable',items:[],errorCode:'DAILY_OVERVIEW_STALE'});
  db.close();
});
it('applies owner preferences as context without removing required deadlines and invalidates old reviews on pause',async()=>{
  const {PersonalRelevanceRepository}=await import('../repos/personal-relevance.js');
  const db=seed();addPlan(db);
  const profiles=new PersonalRelevanceRepository(db,key,()=>now);
  profiles.write(actor,0,true,{preferences:[{direction:'avoid',pattern:'Omit routine astronomy newsletters',evidenceIds:['one','two']}],ignored:{},inputDigest:'test',generatedAt:now.toISOString()});
  const provider=providerFor(context=>{
    expect(context.personalPreferences).toHaveLength(1);expect(context.candidates[0]!.required).toBe(true);
    return {result:{summary:'Deadline',items:[{refs:[context.candidates[0]!.ref],category:'deadline',headline:'Deadline',detail:'Due today',priority:'important'}],questions:[],omittedRefs:[]},usage:{},provider:'fake',model:'synthetic'};
  });
  const service=new DailyOverviewService(db,key,provider,'synthetic',()=>now);
  expect((await service.generate(actor,'preferences-test')).state).toBe('ready');
  const profile=profiles.read(actor);profiles.write(actor,profile.revision,false,profile.state);
  expect(new DailyContextService(db,key,()=>now).build(actor).personalPreferences).toEqual([]);
  expect(service.read(actor)).toMatchObject({state:'unavailable',errorCode:'DAILY_OVERVIEW_STALE'});db.close();
});

it('undoes only the owner’s exact dismissal within five minutes, without changing a plan',async()=>{
  const db=seed();const id=addPlan(db);let clock=now;
  const provider=providerFor(context=>({result:{summary:'One task',items:context.candidates.map(c=>({refs:[c.ref],category:'deadline',headline:c.title,detail:'Due today',priority:'important'})),questions:[],omittedRefs:[]},usage:{},provider:'fake',model:'synthetic'}));
  const service=new DailyOverviewService(db,key,provider,'synthetic',()=>clock);
  const before=await service.generate(actor,'undo');
  const planBefore=new PlanRepository(db,key,()=>now).detail(id,actor.memberId);
  const dismissed=service.dismiss(actor,before.items[0]!.refs,before.revision);
  expect(dismissed.items).toEqual([]);
  expect(()=>service.restore(actor,'bad receipt')).toThrow('UNDO_UNAVAILABLE');
  db.prepare('INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES (?,?,?,?,?,?,?)').run('m2','h1','s2','Other','America/New_York',1,now.toISOString());
  expect(()=>service.restore({memberId:'m2',householdId:'h1'},dismissed.undoToken)).toThrow('UNDO_UNAVAILABLE');
  expect(service.restore(actor,dismissed.undoToken).items).toEqual(before.items);
  expect(()=>service.restore(actor,dismissed.undoToken)).toThrow('UNDO_UNAVAILABLE');
  clock=new Date(now.getTime()+1000);
  const next=service.dismiss(actor,before.items[0]!.refs,before.revision);
  expect(()=>service.restore(actor,dismissed.undoToken)).toThrow('UNDO_UNAVAILABLE');
  clock=new Date(clock.getTime()+300_001);
  expect(()=>service.restore(actor,next.undoToken)).toThrow('UNDO_UNAVAILABLE');
  expect(service.read(actor).items).toEqual([]);
  expect(new PlanRepository(db,key,()=>now).detail(id,actor.memberId)).toEqual(planBefore);
  db.close();
});

it.each(['snooze','complete','delete'])('removes a task after %s from cached reviews without hiding remaining commitments',async(action)=>{
 const db=seed();addPlan(db);
 const {ListService}=await import('./lists.js');const {FakeDailyOverviewProvider}=await import('../ai/daily-overview.js');
 const lists=new ListService(db,key,()=>now),task=lists.create(actor,'todo','Call workshop host',undefined,'m1','2026-03-08','task');
 const service=new DailyOverviewService(db,key,new FakeDailyOverviewProvider('synthetic'),'synthetic',()=>now);
 await service.generate(actor,'snooze-review');const before=service.read(actor);const card=before.items.find(x=>x.title==='Call workshop host')!;
 expect(card).toBeDefined();expect(()=>service.dismiss(actor,card.refs,before.revision)).toThrow('TASK_REQUIRES_ACTION');
 if(action==='snooze') lists.snooze(actor,task.id,task.revision,'2026-03-09');
 else if(action==='complete') lists.update(actor,task.id,task.revision,{completed:true});
 else lists.archive(actor,task.id,task.revision);
 const after=service.read(actor);expect(after.state).toBe('ready');expect(after.items.some(x=>x.title==='Call workshop host')).toBe(false);expect(after.items.some(x=>x.title==='Synthetic deadline')).toBe(true);db.close();
});


it('automatically queues one replacement for stale reviews and recovers without a manual refresh',async()=>{
 const db=seed(),queue=new JobQueue(db,()=>now),provider=new FakeDailyOverviewProvider();
 const service=new DailyOverviewService(db,key,provider,'synthetic',()=>now);
 await service.generate(actor,'initial');
 expect(service.readOrRefresh(actor,queue).state).toBe('ready');
 expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({n:0});
 addPlan(db);
 for(let i=0;i<4;i++)expect(service.readOrRefresh(actor,queue)).toMatchObject({state:'unavailable',errorCode:'DAILY_OVERVIEW_UPDATING'});
 expect(provider.calls).toBe(1);
 expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({n:1});
 expect(db.prepare('SELECT run_after FROM jobs').get()).toEqual({run_after:new Date(now.getTime()+300000).toISOString()});
 const job=service.requestRefresh(actor,queue,1);
 expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({n:1});
 await service.generate(actor,job.dedupeKey);
 expect(service.readOrRefresh(actor,queue).state).toBe('ready');db.close();
});
it('reports exhausted generation budgets accurately without enqueueing endless retries',async()=>{
 const db=seed(),queue=new JobQueue(db,()=>now),service=new DailyOverviewService(db,key,new FakeDailyOverviewProvider(),'synthetic',()=>now),usage=new AiUsageLedger(db,()=>now);
 for(let i=0;i<12;i++)usage.reserve({ownerId:'m1',feature:'daily_overview',logicalRequest:'full-'+i,localDate:'2026-03-08',timezone:'America/New_York',model:'synthetic',promptVersion:DAILY_OVERVIEW_PROMPT_VERSION});
 expect(service.readOrRefresh(actor,queue)).toMatchObject({errorCode:'DAILY_AI_LIMIT',result:{summary:expect.stringContaining('daily generation limit')}});
 expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({n:0});db.close();
});
it('does not automatically generate when consent or the provider is unavailable',()=>{
 const db=seed(),queue=new JobQueue(db,()=>now);
 new DailyOverviewService(db,key,undefined,'synthetic',()=>now).readOrRefresh(actor,queue);
 db.prepare('UPDATE daily_ai_settings SET enabled=0').run();
 new DailyOverviewService(db,key,new FakeDailyOverviewProvider(),'synthetic',()=>now).readOrRefresh(actor,queue);
 expect(db.prepare('SELECT count(*) n FROM jobs').get()).toEqual({n:0});db.close();
});
