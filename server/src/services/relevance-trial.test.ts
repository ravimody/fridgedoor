import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { PlanRepository } from '../repos/plans.js';
import { RelevanceTrialService } from './relevance-trial.js';
import { ConnectionService } from './connections.js';
import { FakeGoogleProvider } from '../providers/google.js';
function setup() {
  const db = new Database(':memory:'); migrate(db);
  let now = new Date('2026-09-19T12:00:00Z'); const clock = () => now;
  const key = keyFromSecret('trial-test');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?,?)').run('h', now.toISOString());
  for (const id of ['a','b']) db.prepare('INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES (?,?,?,?,?,1,?)').run(id,'h',id,id,'America/New_York',now.toISOString());
  const a = { memberId: 'a', householdId: 'h' }, b = { memberId: 'b', householdId: 'h' };
  const repo = new PlanRepository(db,key,clock);
  const facts = { title: 'Synthetic delivery', category: 'other', participants: [], preparationTasks: [], unresolvedFields: [], notes: 'A routine arrival update' };
  const planId = repo.createPrivate(a, facts);
  db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(planId);
  return { db, key, a, b, repo, planId, service: new RelevanceTrialService(db,key,clock), advance: () => { now = new Date(now.getTime()+31*86400000); } };
}
it('stores encrypted snapshots and ratings without modifying plans; retries preparation retain answers', () => {
  const s=setup(); const before=s.repo.detail(s.planId,'a');
  const item=s.service.prepare(s.a,[s.planId]).items[0]!;
  expect(item.facts.title).toBe('Synthetic delivery');
  expect(JSON.stringify(s.db.prepare('SELECT * FROM relevance_trial_items').all())).not.toContain('Synthetic delivery');
  s.service.rate(s.a,item.id,{value:'not_useful',reason:'No routine tracking please',expectedRevision:1});
  expect(JSON.stringify(s.db.prepare('SELECT * FROM relevance_trial_items').all())).not.toContain('No routine');
  expect(s.service.prepare(s.a,[s.planId]).items[0]).toMatchObject({value:'not_useful',revision:2});
  expect(s.repo.detail(s.planId,'a')).toEqual(before);
  expect(() => s.service.rate(s.a,item.id,{value:'useful',expectedRevision:1})).toThrow('STALE_REVISION');
  expect(s.service.rate(s.a,item.id,{value:'useful',expectedRevision:2}).items[0]).toMatchObject({value:'useful',reason:'',revision:3});
  s.db.close();
});
it('enforces owner, membership, expiry and deletion boundaries', () => {
  const s=setup(); const item=s.service.prepare(s.a,[s.planId]).items[0]!;
  expect(s.service.list(s.b).items).toEqual([]);
  expect(() => s.service.prepare(s.b,[s.planId])).toThrow();
  expect(() => s.service.rate(s.b,item.id,{value:'useful',expectedRevision:1})).toThrow('NOT_FOUND');
  s.db.prepare("UPDATE members SET active=0 WHERE id='a'").run();
  expect(() => s.service.list(s.a)).toThrow('NOT_FOUND');
  s.db.prepare("UPDATE members SET active=1 WHERE id='a'").run();
  s.advance(); expect(s.service.list(s.a).items).toEqual([]);
  expect(() => s.service.rate(s.a,item.id,{value:'useful',expectedRevision:1})).toThrow('NOT_FOUND');
  new ConnectionService(s.db,s.key,new FakeGoogleProvider(),'https://example.test').deletePrivateData('a');
  expect(s.db.prepare('SELECT COUNT(*) n FROM relevance_trial_items').get()).toEqual({n:0});
  s.db.close();
});
it('keeps ratings per person even for shared plans; clear affects only the owner', () => {
  const s=setup(); const plan=s.repo.detail(s.planId,'a');
  s.repo.share(s.planId,'a',plan.revision,plan.facts);
  s.db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(s.planId);
  const ai=s.service.prepare(s.a,[s.planId]).items[0]!;
  const bi=s.service.prepare(s.b,[s.planId]).items[0]!;
  s.service.rate(s.a,ai.id,{value:'not_useful',expectedRevision:1});
  s.service.rate(s.b,bi.id,{value:'useful',expectedRevision:1});
  s.service.clear(s.a);
  expect(s.service.list(s.a).items).toEqual([]);
  expect(s.service.list(s.b).items[0]!.value).toBe('useful');
  s.db.close();
});

it('samples five unseen authorized recent plans and preserves earlier ratings across retries', () => {
  const s=setup();
  const first=s.service.prepare(s.a,[s.planId]).items[0]!;
  s.service.rate(s.a,first.id,{value:'useful',expectedRevision:1});
  for(let n=0;n<7;n++) {
    const id=s.repo.createPrivate(s.a,{title:`Synthetic extra ${n}`,category:'other',participants:[],preparationTasks:[],unresolvedFields:[]});
    s.db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(id);
  }
  const foreign=s.repo.createPrivate(s.b,{title:'Other owner secret',category:'other',participants:[],preparationTasks:[],unresolvedFields:[]});
  s.db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(foreign);
  const next=s.service.next(s.a);
  expect(next.items).toHaveLength(6);
  expect(next.items[0]).toMatchObject({id:first.id,value:'useful'});
  expect(next.items.filter(i=>i.value===null)).toHaveLength(5);
  expect(JSON.stringify(next)).not.toContain('Other owner secret');
  expect(s.service.next(s.a)).toEqual(next);
  s.db.close();
});
it('compacts once per input, invalidates edits and keeps summary private and deletable', async () => {
  const s=setup();let calls=0;
  const service=new RelevanceTrialService(s.db,s.key,()=>new Date('2026-09-19T12:00:00Z'),{async summarize(input){calls++;return{overview:'Tentative delivery preference',preferences:[{direction:'avoid',pattern:'Usually omit routine arrival updates; delivery failures are not established.',evidenceIds:[input[0]!.id]}]};}});
  const item=service.prepare(s.a,[s.planId]).items[0]!;
  service.rate(s.a,item.id,{value:'not_useful',expectedRevision:1});
  const result=await service.compact(s.a);expect(result.result.preferences).toHaveLength(1);
  await service.compact(s.a);expect(calls).toBe(1);
  expect(service.summary(s.b)).toBeNull();
  expect(JSON.stringify(s.db.prepare('SELECT * FROM relevance_trial_summaries').all())).not.toContain('delivery preference');
  service.rate(s.a,item.id,{value:'skip',expectedRevision:2});
  expect(service.summary(s.a)).toBeNull();
  await expect(service.compact(s.a)).rejects.toThrow('RATINGS_REQUIRED');
  service.clear(s.a);expect(s.db.prepare('SELECT count(*) n FROM relevance_trial_summaries').get()).toEqual({n:0});s.db.close();
});
it('rejects invented or contradictory summary evidence and results generated across an edit', async () => {
  const s=setup();const item=s.service.prepare(s.a,[s.planId]).items[0]!;
  s.service.rate(s.a,item.id,{value:'useful',expectedRevision:1});
  const invalid=new RelevanceTrialService(s.db,s.key,()=>new Date('2026-09-19T12:00:00Z'),{async summarize(){return{overview:'Bad rule',preferences:[{direction:'avoid',pattern:'Hide all arrivals',evidenceIds:[item.id]}]};}});
  await expect(invalid.compact(s.a)).rejects.toThrow('INVALID_SUMMARY_EVIDENCE');
  const stale=new RelevanceTrialService(s.db,s.key,()=>new Date('2026-09-19T12:00:00Z'),{async summarize(){s.service.rate(s.a,item.id,{value:'not_useful',expectedRevision:2});return{overview:'Draft',preferences:[{direction:'prefer',pattern:'Tentatively useful',evidenceIds:[item.id]}]};}});
  await expect(stale.compact(s.a)).rejects.toThrow('STALE_REVISION');
  expect(s.db.prepare('SELECT count(*) n FROM relevance_trial_summaries').get()).toEqual({n:0});s.db.close();
});

function learningSetup() {
  const s=setup(); let now=new Date('2026-09-19T12:00:00Z'), calls=0;
  s.db.prepare("INSERT INTO daily_ai_settings VALUES (?,1,'daily-assistant-v1',1,?)").run('a',now.toISOString());
  const service=new RelevanceTrialService(s.db,s.key,()=>now,{async summarize(input,previous=[]){calls++;return {overview:'Personal exception',preferences:[...previous,{direction:'prefer' as const,pattern:'Include local astronomy meetups.',evidenceIds:input.filter(item=>item.vote==='useful').map(item=>item.id)}].filter(rule=>rule.evidenceIds.length>0).slice(0,8)};}});
  service.configureLearning(s.a,{enabled:true,expectedRevision:0,consentVersion:'personal-relevance-v1'});
  const item=service.prepare(s.a,[s.planId]).items[0]!;
  return {...s,service,item,calls:()=>calls,nextDay:()=>{now=new Date(now.getTime()+86400000);},learn:()=>service.learn(s.a,{localDate:now.toISOString().slice(0,10),timezone:'America/New_York',consentRevision:1})};
}
it('keeps unexplained single votes tentative, applies explicit preferences privately, and runs at most daily',async()=>{
  const s=learningSetup();
  s.service.rate(s.a,s.item.id,{value:'useful',expectedRevision:1});
  await s.learn();await s.learn();
  expect(s.calls()).toBe(1);expect(s.service.learning(s.a).preferences).toEqual([]);
  s.service.rate(s.a,s.item.id,{value:'useful',reason:'I organize astronomy outings',expectedRevision:2});
  await s.learn();expect(s.calls()).toBe(1);
  s.nextDay();await s.learn();
  expect(s.service.learning(s.a).preferences).toHaveLength(1);
  expect(s.service.learning(s.b)).toMatchObject({enabled:false,preferences:[]});
  expect(JSON.stringify(s.db.prepare('SELECT * FROM personal_relevance').all())).not.toContain('astronomy');
  s.service.rate(s.a,s.item.id,{value:'skip',expectedRevision:3});
  expect(s.service.learning(s.a).preferences).toEqual([]);
  s.db.close();
});
it('forgets preferences without immediately relearning from the same votes; changed votes can teach again',async()=>{
  const s=learningSetup();
  s.service.rate(s.a,s.item.id,{value:'useful',reason:'I organize astronomy outings',expectedRevision:1});
  await s.learn();
  s.service.forgetLearning(s.a,{expectedRevision:s.service.learning(s.a).revision});
  s.nextDay();await s.learn();expect(s.calls()).toBe(1);
  s.service.rate(s.a,s.item.id,{value:'useful',reason:'Please include these again',expectedRevision:2});
  await s.learn();expect(s.service.learning(s.a).preferences).toHaveLength(1);
  s.db.close();
});
it('rejects learning published after opt-out and prevents retrying provider failures the same day',async()=>{
  const s=learningSetup();s.service.rate(s.a,s.item.id,{value:'useful',reason:'Personal interest',expectedRevision:1});
  const changing=new RelevanceTrialService(s.db,s.key,()=>new Date('2026-09-19T12:00:00Z'),{async summarize(){s.service.configureLearning(s.a,{enabled:false,expectedRevision:s.service.learning(s.a).revision});return {overview:'Changed consent',preferences:[]};}});
  await expect(changing.learn(s.a,{localDate:'2026-09-19',timezone:'America/New_York',consentRevision:1})).rejects.toThrow('STALE_REVISION');
  expect(s.service.learning(s.a)).toMatchObject({enabled:false,preferences:[]});
  s.service.configureLearning(s.a,{enabled:true,expectedRevision:s.service.learning(s.a).revision,consentVersion:'personal-relevance-v1'});
  await s.learn();expect(s.calls()).toBe(0);
  new ConnectionService(s.db,s.key,new FakeGoogleProvider(),'https://example.test').deletePrivateData('a');
  expect(s.service.learning(s.a)).toMatchObject({enabled:false,preferences:[]});s.db.close();
});
it('applies two unexplained votes and retains established preferences when raw examples expire',async()=>{
  const s=learningSetup();
  const extra=s.repo.createPrivate(s.a,{title:'Synthetic astronomy meetup',category:'other',participants:[],preparationTasks:[],unresolvedFields:[]});
  s.db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(extra);
  const second=s.service.prepare(s.a,[extra],true).items[1]!;
  s.service.rate(s.a,s.item.id,{value:'useful',expectedRevision:1});
  s.service.rate(s.a,second.id,{value:'useful',expectedRevision:1});
  await s.learn();expect(s.service.learning(s.a).preferences).toHaveLength(1);
  for(let day=0;day<31;day++)s.nextDay();
  expect(s.service.list(s.a).items).toEqual([]);
  await s.learn();expect(s.service.learning(s.a).preferences).toHaveLength(1);expect(s.calls()).toBe(1);
  s.db.close();
});
