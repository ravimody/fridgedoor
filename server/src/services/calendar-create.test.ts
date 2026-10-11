import { Worker } from '../jobs/worker.js';
import type { GmailSync } from '../sync/gmail.js';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { PlanFacts } from '@fridgedoor/contracts';
import { encryptJson, keyFromSecret, indexKey } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { JobQueue } from '../jobs/queue.js';
import { FakeGoogleProvider, GOOGLE_SCOPES, type GoogleGrant } from '../providers/google.js';
import { CalendarRepository } from '../repos/calendar.js';
import { PlanRepository } from '../repos/plans.js';
import { PlanDecisionService } from './plan-decisions.js';
import { CalendarActionService } from './calendar-actions.js';

const now = new Date('2026-01-01T00:00:00.000Z'); const key = keyFromSecret('action-test-secret'); const grant: GoogleGrant = { sub: 'g1', email: 'alex@example.test', scopes: [...GOOGLE_SCOPES], accessToken: 'access', refreshToken: 'refresh', expiresAt: '2030-01-01T00:00:00.000Z' };
function seed() { const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString()); db.prepare('INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('c1', 'm1', 'g1', grant.email, JSON.stringify(grant.scopes), JSON.stringify(encryptJson(grant, key, 'google-connection:c1')), 'active', 1, 'v1', now.toISOString(), now.toISOString(), now.toISOString()); const calendarKey = indexKey('cal1', key); db.prepare('INSERT INTO calendar_selections (id, connection_id, generation, encrypted_calendar_id, calendar_key, selected, classification, provider_access_role, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('sel1', 'c1', 1, JSON.stringify(encryptJson({ id: 'cal1' }, key, `calendar:c1:${calendarKey}`)), calendarKey, 1, 'household', 'owner', 'Household'); db.prepare('INSERT INTO destination_bindings (id, household_id, encrypted_calendar_id, calendar_key, display_name, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('binding1', 'h1', JSON.stringify(encryptJson({ id: 'cal1' }, key, `calendar:c1:${calendarKey}`)), calendarKey, 'Household', 1, now.toISOString()); const facts: PlanFacts = { title: 'School pickup', category: 'school', participants: ['Alex'], time: { kind: 'timed', start: '2026-01-02T15:00:00-05:00', end: '2026-01-02T16:00:00-05:00', timezone: 'America/New_York' }, location: 'Library', preparationTasks: [], unresolvedFields: [] }; db.prepare('INSERT INTO source_items (id, household_id, owner_id, kind, provider_key, encrypted_provider_refs, state, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('s1', 'h1', 'm1', 'capture', 'capture1', '{}', 'available', 1, now.toISOString(), now.toISOString()); db.prepare('INSERT INTO source_versions (id, source_id, sequence, content_digest, encrypted_evidence, observed_at, expires_at, availability, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('v1', 's1', 1, 'digest', JSON.stringify(encryptJson({ providerId: 'capture1', labels: [], text: 'School pickup', attachmentsIncomplete: false }, key, 'source-version:v1')), now.toISOString(), '2026-01-08T00:00:00.000Z', 'available', '{}'); const plan = new PlanRepository(db, key, () => now); const planId = plan.upsertExtraction({ id: 'x1', sourceVersionId: 'v1', ownerId: 'm1', householdId: 'h1', visibility: 'shared', facts, relation: 'new', evidenceRole: 'supporting' }); return { db, planId }; }
describe('calendar action create', () => {
  it('uses one idempotent action and reconciles the durable provider id', async () => { const { db, planId } = seed(); const queue = new JobQueue(db, () => now); const provider = new FakeGoogleProvider(); const service = new CalendarActionService(db, key, queue, provider, () => now); const first = service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'create', 'apply-1'); const replay = service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'create', 'apply-1'); expect(replay).toEqual(first); const job = queue.claim(['calendar_action'])!; expect((await service.run(job)).state).toBe('complete'); expect(service.status({ memberId: 'm1', householdId: 'h1' }, first.actionId).state).toBe('succeeded'); expect(db.prepare('SELECT COUNT(*) AS count FROM event_bindings').get()).toEqual({ count: 1 }); expect(() => service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'create', 'apply-1')).not.toThrow(); });
  it('rejects the same idempotency key with a different request', () => { const { db, planId } = seed(); const service = new CalendarActionService(db, key, new JobQueue(db, () => now), new FakeGoogleProvider(), () => now); service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'create', 'apply-1'); expect(() => service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'update', 'apply-1')).toThrow('IDEMPOTENCY_CONFLICT'); });
  it('refreshes an expired writer grant before a calendar write', async () => {
    const { db, planId } = seed(); db.prepare('UPDATE google_connections SET encrypted_tokens = ?').run(JSON.stringify(encryptJson({ ...grant, expiresAt: '2020-01-01T00:00:00.000Z' }, key, 'google-connection:c1')));
    const provider = new FakeGoogleProvider(); const refresh = vi.spyOn(provider, 'refresh').mockResolvedValue({ ...grant, accessToken: 'renewed' }); const get = vi.spyOn(provider, 'getCalendarEvent'); const queue = new JobQueue(db, () => now); const service = new CalendarActionService(db, key, queue, provider, () => now); const action = service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'create', 'refresh-1');
    expect((await service.run(queue.claim(['calendar_action'])!)).state).toBe('complete');
    expect(refresh).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'renewed' }), 'cal1', expect.any(String)); expect(service.status({ memberId: 'm1', householdId: 'h1' }, action.actionId).state).toBe('succeeded');
  });
  it('reschedules a write while another worker owns the refresh lease', async () => {
    const { db, planId } = seed(); db.prepare('UPDATE google_connections SET encrypted_tokens = ?').run(JSON.stringify(encryptJson({ ...grant, expiresAt: '2020-01-01T00:00:00.000Z' }, key, 'google-connection:c1'))); db.prepare('INSERT INTO google_refresh_leases VALUES (?, ?, ?)').run('c1', 'other', new Date(now.getTime() + 60000).toISOString());
    const provider = new FakeGoogleProvider(); const get = vi.spyOn(provider, 'getCalendarEvent'); const queue = new JobQueue(db, () => now); const service = new CalendarActionService(db, key, queue, provider, () => now); service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'create', 'busy-1');
    expect(await service.run(queue.claim(['calendar_action'])!)).toMatchObject({ state: 'retry', retryKind: 'transient' }); expect(get).not.toHaveBeenCalled();
  });
  it('does not write after the member is disabled during provider reconciliation', async () => {
    const { db, planId } = seed(); const provider = new FakeGoogleProvider(); vi.spyOn(provider, 'getCalendarEvent').mockImplementation(async () => { db.prepare('UPDATE members SET active = 0').run(); return null; }); const queue = new JobQueue(db, () => now); const service = new CalendarActionService(db, key, queue, provider, () => now); const action = service.apply({ memberId: 'm1', householdId: 'h1' }, planId, 1, 'create', 'disable-1');
    expect(await service.run(queue.claim(['calendar_action'])!)).toEqual({ state: 'complete' }); expect(service.status({ memberId: 'm1', householdId: 'h1' }, action.actionId).state).toBe('needs_reauth'); expect(db.prepare('SELECT count(*) AS count FROM event_bindings').get()).toEqual({ count: 0 });
  });
});

it('direct approval shares and queues once, with truthful status after the worker confirms', async () => {
  const { db, planId } = seed(); const actor = { memberId: 'm1', householdId: 'h1' };
  const plans = new PlanRepository(db, key, () => now); const queue = new JobQueue(db, () => now);
  const actions = new CalendarActionService(db, key, queue, new FakeGoogleProvider(), () => now);
  const decisions = new PlanDecisionService(db, plans, actions, () => now);
  const privateId = plans.createPrivate(actor, plans.detail(planId, actor.memberId).facts);
  const first = decisions.decide(actor, privateId, 1, 'calendar');
  expect(first.state).toBe('pending');
  expect(decisions.decide(actor, privateId, 1, 'calendar')).toEqual(first);
  expect(plans.detail(privateId, actor.memberId)).toMatchObject({ visibility: 'shared', calendarAction: { state: 'pending' } });
  await actions.run(queue.claim(['calendar_action'])!);
  expect(decisions.decide(actor, privateId, 1, 'calendar').state).toBe('succeeded');
  expect(db.prepare('SELECT count(*) AS n FROM calendar_actions').get()).toEqual({ n: 1 });
  const calendar = new CalendarRepository(db, key, () => now);
  const stream = calendar.streams()[0]!;
  const eventId = (db.prepare('SELECT provider_event_id FROM calendar_actions').get() as { provider_event_id: string }).provider_event_id;
  calendar.persist(stream, { id: eventId, summary: 'School pickup' }, plans.detail(privateId, actor.memberId).facts.time!, 'destination_context');
  expect(calendar.agendaSafe(actor)).toMatchObject([{ planId: privateId, title: 'School pickup' }]);

});

it('updates the same event, reconciles a lost response, and cancels using the still-readable binding', async () => {
  const { db, planId } = seed(); const actor = { memberId: 'm1', householdId: 'h1' };
  const plans = new PlanRepository(db, key, () => now); const queue = new JobQueue(db, () => now); const provider = new FakeGoogleProvider();
  const actions = new CalendarActionService(db, key, queue, provider, () => now);
  actions.apply(actor, planId, 1, 'create', 'create'); const create = queue.claim(['calendar_action'])!; await actions.run(create); queue.finish(create);
  const current = plans.detail(planId, actor.memberId); const edited = plans.edit(planId, actor.memberId, current.revision, { ...current.facts, title: 'Pickup at new time', location: '' });
  db.prepare('UPDATE destination_bindings SET active = 0').run(); // A new default must not redirect this event.
  const update = actions.apply(actor, planId, edited.revision, 'update', 'update');
  expect(plans.detail(planId, actor.memberId).facts.title).toBe('School pickup');
  expect(() => actions.apply(actor, planId, plans.detail(planId, actor.memberId).revision, 'cancel', 'overlap')).toThrow('ACTION_IN_PROGRESS');
  const write = provider.updateCalendarEvent.bind(provider);
  const updateCall = vi.spyOn(provider, 'updateCalendarEvent').mockImplementationOnce(async (...args) => { await write(...args); throw new Error('GOOGLE_RETRYABLE'); });
  const job = queue.claim(['calendar_action'])!;
  expect((await actions.run(job)).state).toBe('retry');
  expect((await actions.run(job)).state).toBe('complete'); queue.finish(job);
  expect(updateCall).toHaveBeenCalledTimes(1);
  expect(actions.status(actor, update.actionId).state).toBe('succeeded');
  expect(plans.detail(planId, actor.memberId).facts.title).toBe('Pickup at new time');
  const cancel = actions.apply(actor, planId, plans.detail(planId, actor.memberId).revision, 'cancel', 'cancel');
  await actions.run(queue.claim(['calendar_action'])!);
  expect(actions.status(actor, cancel.actionId).state).toBe('succeeded');
  expect(plans.detail(planId, actor.memberId).status).toBe('archived');
  expect(db.prepare('SELECT count(*) n FROM event_bindings').get()).toEqual({ n: 1 });
});

it('preserves a Google edit as a conflict instead of overwriting it', async () => {
  const { db, planId } = seed(); const actor = { memberId: 'm1', householdId: 'h1' }; const plans = new PlanRepository(db, key, () => now);
  const queue = new JobQueue(db, () => now); const provider = new FakeGoogleProvider(); const actions = new CalendarActionService(db, key, queue, provider, () => now);
  actions.apply(actor, planId, 1, 'create', 'create'); const job = queue.claim(['calendar_action'])!; await actions.run(job); queue.finish(job);
  const eventId = (db.prepare('SELECT provider_event_id FROM calendar_actions').get() as { provider_event_id: string }).provider_event_id;
  const original = await provider.getCalendarEvent(grant, 'cal1', eventId);
  vi.spyOn(provider, 'getCalendarEvent').mockResolvedValue({ ...original!, summary: 'Edited in Google', etag: 'external-etag' });
  const write = vi.spyOn(provider, 'updateCalendarEvent');
  const current = plans.detail(planId, actor.memberId); const edited = plans.edit(planId, actor.memberId, current.revision, { ...current.facts, title: 'Planner correction' });
  const action = actions.apply(actor, planId, edited.revision, 'update', 'update'); await actions.run(queue.claim(['calendar_action'])!);
  expect(actions.status(actor, action.actionId).state).toBe('conflict'); expect(write).not.toHaveBeenCalled();
  expect(plans.detail(planId, actor.memberId).facts.title).toBe('School pickup');
  expect(plans.detail(planId, actor.memberId).pendingFacts?.title).toBe('Planner correction');
});

it('keeps a deadline private and rejects a calendar decision atomically until a duration is reviewed', () => {
  const { db, planId } = seed(); const actor = { memberId: 'm1', householdId: 'h1' };
  const plans = new PlanRepository(db, key, () => now); const queue = new JobQueue(db, () => now);
  const actions = new CalendarActionService(db, key, queue, new FakeGoogleProvider(), () => now);
  const decisions = new PlanDecisionService(db, plans, actions, () => now);
  const deadlineId = plans.createPrivate(actor, { ...plans.detail(planId, 'm1').facts, time: { kind: 'deadline', at: '2026-01-02T17:00:00-05:00', timezone: 'America/New_York' } });
  expect(() => decisions.decide(actor, deadlineId, 1, 'calendar')).toThrow('PLAN_TIME_INCOMPLETE');
  expect(plans.detail(deadlineId, 'm1')).toMatchObject({ visibility: 'private', revision: 1, facts: { time: { kind: 'deadline' } } });
  expect(db.prepare('SELECT count(*) n FROM calendar_actions').get()).toEqual({ n: 0 });
  const shared = plans.edit(planId, 'm1', 1, { ...plans.detail(planId, 'm1').facts, time: { kind: 'deadline', at: '2026-01-02T17:00:00-05:00', timezone: 'America/New_York' } });
  expect(() => actions.apply(actor, planId, shared.revision, 'create', 'deadline-direct')).toThrow('PLAN_TIME_INCOMPLETE');
  expect(queue.claim(['calendar_action'])).toBeUndefined();
  decisions.decide(actor, deadlineId, 1, 'keep');
  const kept = plans.detail(deadlineId, 'm1');
  expect(kept.savedInPlanner).toBe(true);
  const edited = plans.edit(deadlineId, 'm1', kept.revision, { ...kept.facts, time: { kind: 'timed', start: '2026-01-02T16:00:00-05:00', end: '2026-01-02T17:00:00-05:00', timezone: 'America/New_York' } });
  expect(decisions.decide(actor, deadlineId, edited.revision, 'calendar').state).toBe('pending');
});

it('recovers a stopped job by checking the same event after a lost create response', async () => {
  const { db, planId } = seed(); const actor = { memberId:'m1',householdId:'h1' }; const queue = new JobQueue(db,()=>now);
  const provider = new FakeGoogleProvider(); const originalCreate = provider.createCalendarEvent.bind(provider);
  const create = vi.spyOn(provider,'createCalendarEvent').mockImplementation(async (...args) => { await originalCreate(...args); throw new Error('RESPONSE_LOST'); });
  const service = new CalendarActionService(db,key,queue,provider,()=>now); const action = service.apply(actor,planId,1,'create','lost');
  const job = queue.claim(['calendar_action'])!; expect((await service.run(job)).state).toBe('retry');
  queue.fail(job,'ACTION_RETRY_LIMIT'); queue.reconcileCalendarActions(); expect(service.status(actor,action.actionId).state).toBe('failed');
  expect(() => service.apply(actor,planId,2,'create','duplicate')).toThrow('RETRY_ORIGINAL_ACTION');
  expect(service.retry(actor,action.actionId,2).state).toBe('pending'); expect(() => service.retry(actor,action.actionId,2)).toThrow('STALE_REVISION');
  const retried = queue.claim(['calendar_action'])!; expect(retried.id).toBe(job.id); expect(retried.attemptCount).toBe(1);
  expect((await service.run(retried)).state).toBe('complete'); expect(create).toHaveBeenCalledOnce();
  expect(service.status(actor,action.actionId).state).toBe('succeeded'); expect(db.prepare('SELECT count(*) n FROM event_bindings').get()).toEqual({n:1});
});
it('marks canceled action jobs for attention and requires current writer access before retry', () => {
  const {db,planId}=seed();const actor={memberId:'m1',householdId:'h1'};const queue=new JobQueue(db,()=>now);const service=new CalendarActionService(db,key,queue,new FakeGoogleProvider(),()=>now);
  const action=service.apply(actor,planId,1,'create','canceled');queue.cancelScope('c1');queue.reconcileCalendarActions();
  expect(service.status(actor,action.actionId).state).toBe('needs_reauth');db.prepare("UPDATE google_connections SET status='needs_reauth'").run();
  expect(()=>service.retry(actor,action.actionId,2)).toThrow('DESTINATION_NOT_ALLOWED');
  db.prepare("UPDATE google_connections SET status='active',generation=2").run();db.prepare('UPDATE calendar_selections SET generation=2').run();
  service.retry(actor,action.actionId,2);expect(queue.claim(['calendar_action'])!.payload.generation).toBe(2);
});
it('does not let a stale worker failure overwrite live or completed action state', async () => {
  const {db,planId}=seed();let time=now;const queue=new JobQueue(db,()=>time);const actor={memberId:'m1',householdId:'h1'};const service=new CalendarActionService(db,key,queue,new FakeGoogleProvider(),()=>time);
  const action=service.apply(actor,planId,1,'create','lease');const stale=queue.claim(['calendar_action'])!;time=new Date(now.getTime()+61000);queue.recoverExpired();const live=queue.claim(['calendar_action'])!;
  expect(queue.fail(stale,'LATE')).toBe(false);queue.reconcileCalendarActions();expect(service.status(actor,action.actionId).state).toBe('pending');
  await service.run(live);queue.fail(live,'LATE_FAILURE');queue.reconcileCalendarActions();expect(service.status(actor,action.actionId).state).toBe('succeeded');
});
it('rejects retry by another actor, disabled members, and changed original facts', () => {
  const {db,planId}=seed();const queue=new JobQueue(db,()=>now);const actor={memberId:'m1',householdId:'h1'};const service=new CalendarActionService(db,key,queue,new FakeGoogleProvider(),()=>now);
  const action=service.apply(actor,planId,1,'create','auth');queue.fail(queue.claim(['calendar_action'])!,'STOP');queue.reconcileCalendarActions();
  expect(()=>service.retry({...actor,memberId:'other'},action.actionId,2)).toThrow('NOT_FOUND');
  db.prepare('UPDATE members SET active=0').run();expect(()=>service.retry(actor,action.actionId,2)).toThrow('NOT_FOUND');db.prepare('UPDATE members SET active=1').run();
  const plans=new PlanRepository(db,key,()=>now); const facts=plans.detail(planId,'m1').facts; plans.edit(planId,'m1',2,{...facts,title:'Changed once'}); plans.edit(planId,'m1',3,{...facts,title:'Changed twice'}); expect(()=>service.retry(actor,action.actionId,4)).toThrow('ORIGINAL_ACTION_CHANGED');
});

it('turns exhausted worker retries into an attention state on the next worker pass', async () => {
  const {db,planId}=seed();const actor={memberId:'m1',householdId:'h1'};const queue=new JobQueue(db,()=>now);const provider=new FakeGoogleProvider();vi.spyOn(provider,'getCalendarEvent').mockRejectedValue(new Error('UNAVAILABLE'));
  const actions=new CalendarActionService(db,key,queue,provider,()=>now);const action=actions.apply(actor,planId,1,'create','exhausted');db.prepare('UPDATE jobs SET attempt_count=5').run();
  const worker=new Worker(queue,{} as GmailSync,db,undefined,()=>now,()=>{},undefined,undefined,actions);
  await worker.runOnce();expect(queue.getByDedupe(`calendar-action:${action.actionId}`)!.state).toBe('failed');
  await worker.runOnce();expect(actions.status(actor,action.actionId).state).toBe('failed');
});
