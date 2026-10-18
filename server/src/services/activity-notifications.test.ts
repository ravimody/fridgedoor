import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { AssistantResult } from '@fridgedoor/contracts';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { FakePushProvider, type PushProvider } from '../providers/push.js';
import { ReminderService } from './reminders.js';
import { AssistantService } from '../ai/assistant-service.js';
import { JobQueue } from '../jobs/queue.js';
import { PlanRepository } from '../repos/plans.js';
import { BackgroundAiService } from './background-ai.js';
import { ActivityNotificationService } from './activity-notifications.js';
const result: AssistantResult = { reply: 'Private synthetic content', items: [{ kind: 'grocery', title: 'Private synthetic item', intent: 'direct', quantity: null, start: null, end: null, notes: null, location: null }], knowledge: [], sources: [], assumptions: [], followups: [] };
function setup(push: PushProvider = new FakePushProvider()) {
  const db = new Database(':memory:'); migrate(db); let now = new Date('2026-09-14T12:00:00Z'); const clock = () => now; const key = keyFromSecret('test');
  db.prepare('UPDATE activity_config SET started_at=?').run(now.toISOString()); db.prepare('INSERT INTO households (id, created_at) VALUES (?,?)').run('h',now.toISOString());
  for (const id of ['a','b']) db.prepare('INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES (?,?,?,?,?,1,?)').run(id,'h',id,id,'America/New_York',now.toISOString());
  const actor = { memberId: 'a', householdId: 'h' }; const reminders = new ReminderService(db,key,push,clock);
  const subscribe = (memberId = 'a', device = memberId) => reminders.subscribe({memberId,householdId:'h'},{endpoint:`https://fcm.googleapis.com/${device}`,p256dh:'synthetic',auth:'synthetic',label:device});
  const assistant = new AssistantService(db,key,true,{async run(){return {result,metrics:{model:'fake',promptVersion:'test',inputTokens:0,outputTokens:0,durationMs:0,tools:[]}};}},clock);
  assistant.consent(actor,true); const queue = new JobQueue(db,clock); let n=0;
  const submit = async (mode: 'direct'|'review'|'failure' = 'direct') => {
    const provider = mode === 'direct' ? assistant : new AssistantService(db,key,true,{async run(){if(mode==='failure')throw new Error('synthetic');return {result:{...result,items:result.items.map(item=>({...item,intent:'proposal' as const}))},metrics:{model:'fake',promptVersion:'test',inputTokens:0,outputTokens:0,durationMs:0,tools:[]}};}},clock);
    const run=provider.submit(actor,`request-${n++}`,'Synthetic request');await provider.run(queue.claim(['assistant'])!);return run.id;
  };
  const service = new ActivityNotificationService(db,key,push,true,clock);
  return {db,key,push,actor,assistant,service,subscribe,submit,advance:(ms=46000)=>{now=new Date(now.getTime()+ms);}};
}
it('groups completed requests, uses generic payloads, and never replays accepted devices',async()=>{
  const s=setup();s.subscribe();s.subscribe('a','second');s.subscribe('b');await s.submit();await s.submit();
  expect(await s.service.deliverDue()).toEqual({sent:0});s.advance();expect(await s.service.deliverDue()).toEqual({sent:2});
  expect(await s.service.deliverDue()).toEqual({sent:0});const sent=(s.push as FakePushProvider).sent;
  expect(sent.map(x=>x.payload.url)).toEqual(['/dashboard/','/dashboard/']);expect(JSON.stringify(sent)).not.toContain('Private synthetic');
  expect(sent[0]!.payload.title).toBe('Fridgedoor update');
});
it('suppresses direct updates while visible, but alerts for review and links the exact request',async()=>{
  const s=setup();s.subscribe();await s.submit();await s.service.deliverDue();s.advance();s.assistant.presence(s.actor,'tab',true);
  expect(await s.service.deliverDue()).toEqual({sent:0});const id=await s.submit('review');await s.service.deliverDue();s.advance();s.assistant.presence(s.actor,'tab',true);
  expect(await s.service.deliverDue()).toEqual({sent:1});expect((s.push as FakePushProvider).sent[0]!.payload).toMatchObject({title:'Fridgedoor review',body:'1 list item is ready for review.',url:`/dashboard/requests/${id}`});
});
it('does not alert for already reviewed, deleted, or consent-revoked results',async()=>{
  const s=setup();s.subscribe();const id=await s.submit('review');await s.service.deliverDue();s.assistant.review(s.actor,id,'item',0,'dismiss');s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
  const deleted=await s.submit('review');await s.service.deliverDue();s.assistant.remove(s.actor,deleted);s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
  await s.submit('review');await s.service.deliverDue();s.assistant.consent(s.actor,false);s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
});
it('retries transient delivery, preserves its tag, and stops after acceptance',async()=>{
  const push=new FakePushProvider();const send=vi.spyOn(push,'send').mockResolvedValueOnce('retry' as never).mockResolvedValue('accepted');
  const s=setup(push);s.subscribe();await s.submit('failure');await s.service.deliverDue();s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
  s.advance(61000);expect(await s.service.deliverDue()).toEqual({sent:1});await s.service.deliverDue();expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]![1]).toEqual(send.mock.calls[1]![1]);
});
it('reclaims an abandoned delivery lease and rechecks disabled recipients',async()=>{
  const s=setup();s.subscribe();await s.submit('review');await s.service.deliverDue();
  s.db.prepare("UPDATE activity_deliveries SET attempts=1").run();s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});s.advance(16000);expect(await s.service.deliverDue()).toEqual({sent:1});
  await s.submit('failure');await s.service.deliverDue();s.db.prepare("UPDATE members SET active=0 WHERE id='a'").run();s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
});
it('does not replay pre-rollout or expired activity',async()=>{
  const s=setup();s.subscribe();await s.submit();s.db.prepare("UPDATE activity_config SET started_at='2026-09-15T00:00:00Z'").run();await s.service.deliverDue();s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
});
it('notifies only authorized members about extracted deadlines before the next morning',async()=>{
  const s=setup();s.subscribe();s.subscribe('b');const plans=new PlanRepository(s.db,s.key);const facts={title:'Private source',category:'household',participants:[],preparationTasks:[],unresolvedFields:[],time:{kind:'deadline' as const,at:'2026-09-14T18:00:00Z',timezone:'America/New_York'}};
  const id=plans.createPrivate(s.actor,facts);s.db.prepare("UPDATE plan_versions SET origin='extraction',created_at='2026-09-14T12:00:00Z' WHERE plan_id=?").run(id);
  await s.service.deliverDue();s.advance();expect(await s.service.deliverDue()).toEqual({sent:1});
  const shared=plans.share(id,'a',plans.detail(id,'a').revision,facts);s.db.prepare("UPDATE plan_versions SET origin='extraction',created_at='2026-09-14T12:00:46Z' WHERE id=(SELECT current_version_id FROM plans WHERE id=?)").run(shared.id);
  await s.service.deliverDue();s.advance();expect(await s.service.deliverDue()).toEqual({sent:2});
});
it('reports a terminal calendar result to its actor and suppresses it when superseded',async()=>{
  const s=setup();s.subscribe();s.subscribe('b');const plans=new PlanRepository(s.db,s.key);
  const id=plans.createPrivate(s.actor,{title:'Synthetic event',category:'household',participants:[],preparationTasks:[],unresolvedFields:[]});
  s.db.prepare("INSERT INTO google_connections (id,member_id,google_sub,email,grants_json,encrypted_tokens,status,generation,disclosure_version,consented_at,created_at,updated_at) VALUES ('gc','a','sub','synthetic@example.test','[]','{}','active',1,'v1',?,?,?)").run('2026-09-14T12:00:00Z','2026-09-14T12:00:00Z','2026-09-14T12:00:00Z');
  s.db.prepare("INSERT INTO destination_bindings VALUES ('dest','h','{}','key','Synthetic',1,'2026-09-14T12:00:00Z')").run();
  const version=(s.db.prepare('SELECT current_version_id FROM plans WHERE id=?').get(id) as {current_version_id:string}).current_version_id;
  s.db.prepare("INSERT INTO calendar_actions (id,household_id,plan_id,plan_version_id,actor_id,writer_connection_id,writer_generation,binding_id,kind,payload_json,payload_digest,provider_event_id,state,created_at,updated_at) VALUES ('action','h',?,?,'a','gc',1,'dest','create','{}','digest','event','conflict',?,?)").run(id,version,'2026-09-14T12:00:00Z','2026-09-14T12:00:00Z');
  await s.service.deliverDue();s.advance();expect(await s.service.deliverDue()).toEqual({sent:1});
  expect((s.push as FakePushProvider).sent[0]!.payload).toMatchObject({title:'Fridgedoor needs attention',url:`/dashboard/plans/${id}`});
  s.db.prepare("UPDATE calendar_actions SET state='succeeded',updated_at='2026-09-14T12:00:46Z'").run();await s.service.deliverDue();
  s.db.prepare("UPDATE calendar_actions SET state='running'").run();s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
});
it('expires old batches and never rediscovers them after metadata cleanup',async()=>{
  const s=setup();s.subscribe();await s.submit('review');await s.service.deliverDue();s.advance(10*86400000);
  expect(await s.service.deliverDue()).toEqual({sent:0});expect(s.db.prepare('SELECT count(*) n FROM activity_groups').get()).toEqual({n:0});
});
it('disables a gone endpoint and stops delivery attempts',async()=>{
  const push:PushProvider={send:vi.fn().mockResolvedValue('gone')};const s=setup(push);s.subscribe();await s.submit('review');await s.service.deliverDue();s.advance();await s.service.deliverDue();s.advance(61000);await s.service.deliverDue();
  expect(push.send).toHaveBeenCalledOnce();expect(s.db.prepare('SELECT status FROM push_subscriptions').get()).toEqual({status:'disabled'});
});

it('alerts only the affected owner once per rolling day and suppresses resolved volume', async () => {
  const s=setup(); s.subscribe(); s.subscribe('b');
  let warning = true;
  const status = vi.spyOn(BackgroundAiService.prototype, 'status').mockImplementation(actor => ({
    provider: null, providerLabel: null, model: null, failuresLastDay: 0, available: true, enabled: true, revision: 1,
    connectionActive: true, attemptsLastDay: 300, attemptsLastHour: 300,
    volumeWarning: actor.memberId === 'a' && warning, pausedForVolume: false,
    dailyLimit: 3000, hourlyLimit: 500, pending: 0, lastProcessedAt: null,
  }));
  try {
    await s.service.deliverDue(); s.advance();
    expect(await s.service.deliverDue()).toEqual({sent:1});
    expect((s.push as FakePushProvider).sent[0]!.payload).toMatchObject({title:'Fridgedoor: unusual email processing',url:'/dashboard/settings/email'});
    s.advance(3600000); expect(await s.service.deliverDue()).toEqual({sent:0});
    s.advance(86400000); await s.service.deliverDue(); warning=false; s.advance();
    expect(await s.service.deliverDue()).toEqual({sent:0});
    expect(s.db.prepare("SELECT DISTINCT member_id FROM activity_events WHERE source_kind='email_volume'").all()).toEqual([{member_id:'a'}]);
  } finally { status.mockRestore(); }
});

it('preserves queued activity and delivery history when expanding event kinds', async () => {
  const s=setup();s.subscribe();await s.submit('review');await s.service.deliverDue();
  const events=s.db.prepare('SELECT * FROM activity_events').all();
  const deliveries=s.db.prepare('SELECT * FROM activity_deliveries').all();
  s.db.prepare("DELETE FROM schema_migrations WHERE name='0023_email_volume_activity.sql'").run();
  migrate(s.db);
  expect(s.db.prepare('SELECT * FROM activity_events').all()).toEqual(events);
  expect(s.db.prepare('SELECT * FROM activity_deliveries').all()).toEqual(deliveries);
  expect(s.db.pragma('foreign_key_check')).toEqual([]);
  s.advance();expect(await s.service.deliverDue()).toEqual({sent:1});
});

it('keeps ordinary extracted events and distant deadlines for the morning, with no push',async()=>{
  const s=setup();s.subscribe();const plans=new PlanRepository(s.db,s.key);
  for(const time of [undefined,{kind:'timed' as const,start:'2026-09-14T15:00:00Z',end:'2026-09-14T16:00:00Z',timezone:'America/New_York'},{kind:'deadline' as const,at:'2026-09-17T18:00:00Z',timezone:'America/New_York'}]) {
    const id=plans.createPrivate(s.actor,{title:'Synthetic optional suggestion',category:'household',participants:[],preparationTasks:[],unresolvedFields:[],...(time?{time}:{})});
    s.db.prepare("UPDATE plan_versions SET origin='extraction',created_at='2026-09-14T12:00:00Z' WHERE plan_id=?").run(id);
  }
  await s.service.deliverDue();s.advance();expect(await s.service.deliverDue()).toEqual({sent:0});
  expect(plans.list('a')).toHaveLength(3);s.db.close();
});

it('words a notification about a mix of items neutrally', () => {
  const db = new Database(':memory:'); migrate(db);
  const service = new ActivityNotificationService(db, keyFromSecret('test'), new FakePushProvider(), true) as unknown as { copy(actor: object, group: object, events: object[]): string };
  const actor = { memberId: 'a', householdId: 'h' }; const group = (kind: string) => ({ id: 'g', member_id: 'a', kind, expires_at: '' });
  expect(service.copy(actor, group('failure'), [{ source_kind: 'request', source_id: 'r' }])).toBe('Your assistant request needs attention.');
  expect(service.copy(actor, group('failure'), [{ source_kind: 'request', source_id: 'r' }, { source_kind: 'action', source_id: 'x' }])).toBe('A few household items need your attention.');
  expect(service.copy(actor, group('update'), [{ source_kind: 'request', source_id: 'r' }, { source_kind: 'action', source_id: 'x' }])).toBe('Your household requests have updates.');
});
