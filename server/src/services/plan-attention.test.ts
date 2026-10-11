import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {migrate} from '../db/migrate.js';
import {encryptJson,keyFromSecret} from '../crypto.js';
import {PlanRepository} from '../repos/plans.js';
import {SuggestionService} from '../domain/suggestions.js';
import {ExtractionService} from '../ai/extract.js';
import {FakeAiProvider} from '../providers/ai.js';
import {FakePushProvider} from '../providers/push.js';
import {ReminderService} from './reminders.js';
import {ActivityNotificationService} from './activity-notifications.js';
import {PlanAttentionService} from './plan-attention.js';
import {JobQueue} from '../jobs/queue.js';
async function setup(time?:import('@fridgedoor/contracts').NormalizedTime) {
  const db=new Database(':memory:');migrate(db);const key=keyFromSecret('attention-test');let now=new Date('2026-09-19T14:00:00Z');const clock=()=>now;
  db.prepare('INSERT INTO households (id, created_at) VALUES (?,?)').run('h',now.toISOString());db.prepare('UPDATE activity_config SET started_at=?').run(now.toISOString());
  for(const id of ['a','b'])db.prepare("INSERT INTO members (id,household_id,access_subject,display_name,timezone,active,created_at) VALUES (?,'h',?,?,'America/New_York',1,?)").run(id,id,id,now.toISOString());
  db.prepare("INSERT INTO google_connections (id,member_id,google_sub,email,grants_json,encrypted_tokens,status,generation,disclosure_version,consented_at,created_at,updated_at) VALUES ('c','a','g','test@example.test','[]','{}','active',1,'v1',?,?,?)").run(now.toISOString(),now.toISOString(),now.toISOString());
  db.prepare("INSERT INTO background_ai_settings VALUES ('a',1,'background-ai-v1',1,?)").run(now.toISOString());
  db.prepare("INSERT INTO source_items (id,household_id,owner_id,connection_id,kind,provider_key,encrypted_provider_refs,current_version_id,state,generation,created_at,updated_at) VALUES ('s','h','a','c','gmail_message','key','{}','v','available',1,?,?)").run(now.toISOString(),now.toISOString());
  const text='Our pickup driver is unavailable today. Please tell us who can collect the children.';
  db.prepare("INSERT INTO source_versions (id,source_id,sequence,content_digest,encrypted_evidence,observed_at,original_at,expires_at,availability,metadata_json) VALUES ('v','s',1,'digest',?,?,?,'2026-09-21T14:00:00Z','available','{}')").run(JSON.stringify(encryptJson({text,labels:['INBOX'],internalDate:now.toISOString()},key,'source-version:v')),now.toISOString(),now.toISOString());
  const attention=new PlanAttentionService(db,key,clock),plans=new PlanRepository(db,key,clock);
  const suggestions=new SuggestionService(plans,input=>attention.record(input));
  const provider=new FakeAiProvider();const original=provider.extract.bind(provider);
  provider.extract=async(packet,signal)=>{
    expect(packet.nextMorningReview).toBe('2026-09-20T11:00:00.000Z');
    const output=await original(packet,signal);if(time)output.result.candidates[0]!.safeFacts.time=time;output.result.candidates[0]!.attention={kind:'coordination',reason:'Confirm alternate pickup today.',evidenceQuote:text};return output;
  };
  const queue=new JobQueue(db,clock);queue.enqueue({kind:'extract_source',scopeId:'c',dedupeKey:'test',payload:{sourceVersionId:'v',generation:1}});
  await new ExtractionService(db,key,provider,'synthetic-v1',clock,input=>suggestions.ingest(input)).run(queue.claim(['extract_source'])!);
  const plan=plans.list('a')[0]!;
  const push=new FakePushProvider(),reminders=new ReminderService(db,key,push,clock);
  for(const memberId of ['a','b'])reminders.subscribe({memberId,householdId:'h'},{endpoint:`https://fcm.googleapis.com/${memberId}`,p256dh:'synthetic',auth:'synthetic',label:memberId});
  return {db,key,attention,plans,plan,push,service:new ActivityNotificationService(db,key,push,true,clock),advance:(ms=46000)=>{now=new Date(now.getTime()+ms);}};
}
it('carries urgency from the existing extraction to an owner-only push without an invented deadline',async()=>{
  const s=await setup();expect(s.plan.facts.time).toBeUndefined();
  expect(s.attention.current({memberId:'a',householdId:'h'},s.plan.id)).toBe('coordination');
  expect(s.attention.current({memberId:'b',householdId:'h'},s.plan.id)).toBeNull();
  expect(JSON.stringify(s.db.prepare('SELECT * FROM plan_attention').all())).not.toContain('pickup');
  await s.service.deliverDue();s.advance();expect(await s.service.deliverDue()).toEqual({sent:1});
  expect(s.push.sent[0]!.payload.body).toBe('Household coordination needs an answer before your next morning review.');
  expect(s.push.sent[0]!.payload.url).toBe(`/dashboard/plans/${s.plan.id}`);
  await s.service.deliverDue();expect(s.push.sent).toHaveLength(1);s.db.close();
});
it.each([
  "UPDATE background_ai_settings SET enabled=0",
  "UPDATE background_ai_settings SET revision=2",
  "UPDATE google_connections SET generation=2",
  "UPDATE google_connections SET status='disconnected'",
  "UPDATE source_versions SET availability='expired'",
  "UPDATE plans SET status='dismissed'",
  "UPDATE members SET active=0 WHERE id='a'",
])('rechecks %s before delivering queued urgent activity',async sql=>{
  const s=await setup();await s.service.deliverDue();s.db.exec(sql);s.advance();
  expect(await s.service.deliverDue()).toEqual({sent:0});s.db.close();
});
it('expires semantic urgency after an hour rather than reviving it the next day',async()=>{
  const s=await setup();await s.service.deliverDue();s.advance(3600001);expect(await s.service.deliverDue()).toEqual({sent:0});s.db.close();
});
it('leaves anything dated after the next morning review for the review instead of alerting',async()=>{
  const later=await setup({kind:'timed',start:'2026-09-24T17:30:00-04:00',end:'2026-09-24T18:30:00-04:00',timezone:'America/New_York'});
  expect(later.attention.current({memberId:'a',householdId:'h'},later.plan.id)).toBeNull();later.db.close();
  const tonight=await setup({kind:'timed',start:'2026-09-19T17:30:00-04:00',end:'2026-09-19T18:30:00-04:00',timezone:'America/New_York'});
  expect(tonight.attention.current({memberId:'a',householdId:'h'},tonight.plan.id)).toBe('coordination');tonight.db.close();
});
