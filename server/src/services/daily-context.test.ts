import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { PlanRepository } from '../repos/plans.js';
import type { CalendarEventPayload } from '../repos/calendar.js';
import { DailyContextService } from './daily-context.js';

const key = keyFromSecret('daily-context-test');
const now = new Date('2026-03-08T16:00:00.000Z');
const actor = { memberId: 'm1', householdId: 'h1' };

function seed() {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Owner', 'America/New_York', 1, now.toISOString());
  db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m2', 'h1', 's2', 'Other owner', 'America/New_York', 1, now.toISOString());
  const connection = (id: string, memberId: string, status = 'active') => db.prepare('INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, memberId, id, `${memberId}@example.test`, '[]', '{}', status, 1, 'v1', now.toISOString(), now.toISOString(), now.toISOString());
  connection('c1', 'm1'); connection('c2', 'm2');
  const selection = (id: string, connectionId: string, selected = 1) => db.prepare('INSERT INTO calendar_selections (id, connection_id, generation, encrypted_calendar_id, calendar_key, selected, classification, provider_access_role, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, connectionId, 1, '{}', id, selected, 'household', 'owner', id);
  selection('s1', 'c1'); selection('s2', 'c2');
  db.prepare("INSERT INTO sync_states (id, connection_id, source_kind, stream_key, query_version, generation, last_success_at, created_at, updated_at) VALUES ('cal-sync-1', 'c1', 'calendar', 's1', 'calendar-v1', 1, ?, ?, ?), ('gmail-sync-1', 'c1', 'gmail', 'mailbox', 'gmail-v1', 1, ?, ?, ?)").run(now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());
  return db;
}

function calendar(db: Database.Database, input: { id: string; sourceId?: string; ownerId?: string; providerEventId?: string; iCalUID?: string; originalStartTime?: string; title: string; time: CalendarEventPayload['normalizedTime']; visibility?: CalendarEventPayload['visibility']; selectionId?: string }) {
  const sourceId = input.sourceId ?? `source-${input.id}`;
  const ownerId = input.ownerId ?? 'm1';
  const selectionId = input.selectionId ?? (ownerId === 'm1' ? 's1' : 's2');
  const connectionId = ownerId === 'm1' ? 'c1' : 'c2';
  db.prepare("INSERT INTO source_items (id, household_id, owner_id, connection_id, kind, provider_key, encrypted_provider_refs, state, generation, created_at, updated_at) VALUES (?, 'h1', ?, ?, 'calendar_event', ?, '{}', 'available', 1, ?, ?)").run(sourceId, ownerId, connectionId, input.id, now.toISOString(), now.toISOString());
  const payload: CalendarEventPayload = { providerEventId: input.providerEventId ?? input.id, summary: input.title, ...(input.iCalUID ? { iCalUID: input.iCalUID } : {}), ...(input.originalStartTime ? { originalStartTime: input.originalStartTime } : {}), normalizedTime: input.time, visibility: input.visibility ?? (ownerId === 'm1' ? 'shared_eligible' : 'owner') };
  db.prepare('INSERT INTO calendar_occurrences (id, source_id, calendar_selection_id, occurrence_key, provider_event_key, normalized_time_json, encrypted_payload, status, visibility, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)').run(input.id, sourceId, selectionId, input.id, input.id, JSON.stringify(input.time), JSON.stringify(encryptJson(payload, key, `calendar-occurrence:${input.id}`)), 'confirmed', payload.visibility, new Date(now.getTime() + 7 * 86400000).toISOString(), now.toISOString(), now.toISOString());
}

function source(db: Database.Database, id: string, evidence: { subject?: string; sender?: string; text?: string; labels?: string[] }, observedAt = now.toISOString()) {
  const versionId = `${id}-version`;
  db.prepare("INSERT INTO source_items (id, household_id, owner_id, connection_id, kind, provider_key, encrypted_provider_refs, current_version_id, state, generation, created_at, updated_at) VALUES (?, 'h1', 'm1', 'c1', 'gmail_message', ?, '{}', ?, 'available', 1, ?, ?)").run(id, id, versionId, observedAt, observedAt);
  db.prepare("INSERT INTO source_versions (id, source_id, sequence, content_digest, encrypted_evidence, observed_at, original_at, expires_at, availability, metadata_json) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'available', '{}')").run(versionId, id, id, JSON.stringify(encryptJson({ providerId: id, labels: ['INBOX'], text: evidence.text ?? '', attachmentsIncomplete: false, ...evidence }, key, `source-version:${versionId}`)), observedAt, observedAt, new Date(now.getTime() + 7 * 86400000).toISOString());
}

describe('daily context', () => {
  it('keeps old unsaved email suggestions out of the morning review without hiding commitments or real to-dos', () => {
    const db = seed();
    const plans = new PlanRepository(db, key, () => now);
    const create = (title: string, time?: { kind: 'deadline'; at: string; timezone: string } | { kind: 'timed'; start: string; end: string; timezone: string }) => {
      const id = plans.createPrivate(actor, { title, category: 'other', participants: [], ...(time ? { time } : {}), preparationTasks: ['Suggested preparation'], unresolvedFields: [] });
      db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(id);
      return id;
    };
    const old = create('Old undated suggestion');
    db.prepare('UPDATE plans SET created_at=? WHERE id=?').run('2026-02-01T12:00:00.000Z', old);
    const upcoming = create('Upcoming suggestion', { kind: 'deadline', at: '2026-03-10T12:00:00-04:00', timezone: 'America/New_York' });
    db.prepare('UPDATE plans SET created_at=? WHERE id=?').run('2026-02-01T12:00:00.000Z', upcoming);
    const laterEvent = create('Later optional event', { kind: 'timed', start: '2026-03-14T12:00:00-04:00', end: '2026-03-14T13:00:00-04:00', timezone: 'America/New_York' });
    db.prepare('UPDATE plans SET created_at=? WHERE id=?').run('2026-02-01T12:00:00.000Z', laterEvent);
    const laterDeadline = create('Later consequential deadline', { kind: 'deadline', at: '2026-03-14T12:00:00-04:00', timezone: 'America/New_York' });
    db.prepare('UPDATE plans SET created_at=? WHERE id=?').run('2026-02-01T12:00:00.000Z', laterDeadline);
    create('Fresh undated suggestion');
    plans.createPrivate(actor, { title: 'Saved commitment', category: 'other', participants: [], preparationTasks: ['Actual preparation'], unresolvedFields: [] });
    db.prepare("INSERT INTO list_items (id, household_id, kind, title, created_by, created_at, updated_at) VALUES ('real-todo', 'h1', 'todo', 'Real to-do', 'm1', ?, ?)").run(now.toISOString(), now.toISOString());
    const context = new DailyContextService(db, key, () => now).build(actor);
    const titles = context.candidates.map(candidate => candidate.title);
    expect(titles).not.toContain('Old undated suggestion');
    expect(titles).toContain('Upcoming suggestion');
    expect(titles).not.toContain('Later optional event');
    expect(titles).toContain('Later consequential deadline');
    expect(titles).toContain('Fresh undated suggestion');
    expect(titles).toContain('Saved commitment');
    expect(titles).toContain('Actual preparation');
    expect(titles).toContain('Real to-do');
    expect(titles).not.toContain('Suggested preparation');
    expect(context.truncation.omittedByKind.task).toBe(0);
    db.close();
  });
  it('excludes cached non-Inbox email from the review input and omission count', () => {
    const db=seed();source(db,'inbox',{subject:'Inbox message'});source(db,'archived',{subject:'Archived message',labels:[]});
    const context=new DailyContextService(db,key,()=>now).build(actor);
    expect(context.candidates.filter(c=>c.kind==='source').map(c=>c.title)).toEqual(['Inbox message']);
    expect(context.truncation.omittedByKind.source).toBe(0);db.close();
  });
  it('reserves context for today and upcoming calendar commitments before extracted backlog', () => {
    const db = seed();
    const plans = new PlanRepository(db, key, () => now);
    for (let index = 0; index < 180; index++) {
      const id = plans.createPrivate(actor, { title: `Optional offer ${index}`, category: 'other', participants: [], time: { kind: 'deadline', at: '2026-03-07T12:00:00-05:00', timezone: 'America/New_York' }, notes: 'Long optional source details. '.repeat(40), preparationTasks: [], unresolvedFields: [] });
      db.prepare("UPDATE plan_versions SET origin='extraction' WHERE plan_id=?").run(id);
    }
    calendar(db, { id: 'today', title: 'Today commitment', time: { kind: 'timed', start: '2026-03-08T09:00:00-04:00', end: '2026-03-08T10:00:00-04:00', timezone: 'America/New_York' } });
    calendar(db, { id: 'tomorrow', title: 'Tomorrow lunch, time TBD', time: { kind: 'timed', start: '2026-03-09T12:00:00-04:00', end: '2026-03-09T13:00:00-04:00', timezone: 'America/New_York' } });
    const context = new DailyContextService(db, key, () => now).build(actor);
    expect(context.candidates.slice(0, 2).map(item => item.title)).toEqual(['Today commitment', 'Tomorrow lunch, time TBD']);
    expect(context.candidates[0]?.required).toBe(true);
    expect(context.truncation.omittedByKind.calendar).toBe(0);
    expect(context.truncation.omittedByKind.plan).toBeGreaterThan(0);
    expect(context.truncation.estimatedInputTokens).toBeLessThanOrEqual(12_000);
    db.close();
  });

  it('filters a large historical backlog before the candidate budget and keeps current commitments', () => {
    const db = seed();
    for (let index = 0; index < 1_000; index++) calendar(db, { id: `old-${index}`, title: 'Old appointment', time: { kind: 'all_day', startDate: '2025-01-01', endDateExclusive: '2025-01-02' } });
    calendar(db, { id: 'today', title: 'School clothing instruction', time: { kind: 'timed', start: '2026-03-08T09:00:00-04:00', end: '2026-03-08T10:00:00-04:00', timezone: 'America/New_York' } });
    for (let index = 0; index < 200; index++) calendar(db, { id: `future-${index}`, title: `Future ${index}`, time: { kind: 'timed', start: '2026-03-10T09:00:00-04:00', end: '2026-03-10T10:00:00-04:00', timezone: 'America/New_York' } });
    const context = new DailyContextService(db, key, () => now).build(actor);
    expect(context.referenceDate).toBe('2026-03-08');
    expect(context.candidates.some((candidate) => candidate.title === 'School clothing instruction')).toBe(true);
    expect(context.candidates.length).toBeLessThanOrEqual(150);
    expect(context.candidates.some((candidate) => candidate.title === 'Old appointment')).toBe(false);
    expect(context.truncation.omittedCount).toBeGreaterThan(0);
    expect(context.truncation.estimatedInputTokens).toBeLessThanOrEqual(12_000);
    db.close();
  });

  it('uses local date boundaries, preserves recurrence occurrences, and keeps unrelated same-title events', () => {
    const db = seed();
    calendar(db, { id: 'overnight', title: 'Overnight handoff', time: { kind: 'timed', start: '2026-03-08T04:30:00Z', end: '2026-03-08T06:30:00Z', timezone: 'UTC' } });
    calendar(db, { id: 'all-day', title: 'No school', time: { kind: 'all_day', startDate: '2026-03-08', endDateExclusive: '2026-03-10' } });
    calendar(db, { id: 'recurrence-1', providerEventId: 'series-1', iCalUID: 'series', originalStartTime: '2026-03-09T09:00:00-04:00', title: 'Art class', time: { kind: 'timed', start: '2026-03-09T13:00:00Z', end: '2026-03-09T14:00:00Z', timezone: 'UTC' } });
    calendar(db, { id: 'recurrence-2', providerEventId: 'series-2', iCalUID: 'series', originalStartTime: '2026-03-10T09:00:00-04:00', title: 'Art class', time: { kind: 'timed', start: '2026-03-10T13:00:00Z', end: '2026-03-10T14:00:00Z', timezone: 'UTC' } });
    calendar(db, { id: 'same-title-1', providerEventId: 'appointment-1', title: 'Appointment', time: { kind: 'timed', start: '2026-03-11T13:00:00Z', end: '2026-03-11T14:00:00Z', timezone: 'UTC' } });
    calendar(db, { id: 'same-title-2', providerEventId: 'appointment-2', title: 'Appointment', time: { kind: 'timed', start: '2026-03-12T13:00:00Z', end: '2026-03-12T14:00:00Z', timezone: 'UTC' } });
    calendar(db, { id: 'outside', title: 'Outside lookahead', time: { kind: 'all_day', startDate: '2026-03-16', endDateExclusive: '2026-03-17' } });
    const context = new DailyContextService(db, key, () => now).build(actor);
    const titles = context.candidates.map((candidate) => candidate.title);
    expect(titles).toContain('Overnight handoff');
    expect(titles).toContain('No school');
    expect(titles.filter((title) => title === 'Art class')).toHaveLength(2);
    expect(titles.filter((title) => title === 'Appointment')).toHaveLength(2);
    expect(titles).not.toContain('Outside lookahead');
    db.close();
  });

  it('enforces owner and state filters, exposes stale coverage, and produces a sourced fallback', () => {
    const db = seed();
    calendar(db, { id: 'private-other', ownerId: 'm2', title: 'Other owner private event', time: { kind: 'timed', start: '2026-03-08T15:00:00-04:00', end: '2026-03-08T16:00:00-04:00', timezone: 'America/New_York' } });
    calendar(db, { id: 'private-own', title: 'Owner private event', visibility: 'owner', time: { kind: 'timed', start: '2026-03-08T16:00:00-04:00', end: '2026-03-08T17:00:00-04:00', timezone: 'America/New_York' } });
    source(db, 'recent-source', { sender: 'school@example.test', text: 'Bring a jacket.' });
    db.prepare('UPDATE sync_states SET last_success_at = ? WHERE source_kind = \'gmail\'').run(new Date(now.getTime() - 31 * 60000).toISOString());
    const planId = new PlanRepository(db, key, () => now).createPrivate(actor, { title: 'Form deadline', category: 'school', participants: [], time: { kind: 'deadline', at: '2026-03-08T23:00:00-04:00', timezone: 'America/New_York' }, preparationTasks: ['Book appointment'], unresolvedFields: [] });
    db.prepare("INSERT INTO list_items (id, household_id, kind, title, created_by, created_at, updated_at) VALUES ('done', 'h1', 'todo', 'Completed task', 'm1', ?, ?), ('open', 'h1', 'todo', 'Due task', 'm1', ?, ?)").run(now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());
    db.prepare("UPDATE list_items SET completed_at = ? WHERE id = 'done'").run(now.toISOString());
    db.prepare("INSERT INTO reminders (id, household_id, recipient_id, parent_type, parent_id, due_at, timezone, revision, state, created_by, created_at, updated_at) VALUES ('reminder', 'h1', 'm1', 'plan', ?, '2026-03-08T20:00:00.000Z', 'America/New_York', 1, 'active', 'm1', ?, ?)").run(planId, now.toISOString(), now.toISOString());
    db.prepare('INSERT INTO assistant_knowledge (owner_id, fact_key, encrypted_value, updated_at) VALUES (?, ?, ?, ?)').run('m1', 'school', JSON.stringify(encryptJson('Elementary school', key, 'knowledge:m1:school')), now.toISOString());
    const context = new DailyContextService(db, key, () => now).build(actor);
    const titles = context.candidates.map((candidate) => candidate.title);
    expect(titles).toContain('Owner private event');
    expect(titles).toContain('Form deadline');
    expect(titles).toContain('Book appointment');
    expect(titles).toContain('Due task');
    expect(titles).toContain('Form deadline');
    expect(titles).not.toContain('Other owner private event');
    expect(titles).not.toContain('Completed task');
    expect(context.knowledge).toEqual([{ key: 'school', value: 'Elementary school', validity: 'current', revision: 1, provenance: 'legacy', confirmation: 'unconfirmed', validFrom: null, validUntil: null }]);
    expect(context.coverage.find((entry) => entry.channel === 'email')?.status).toBe('stale');
    const fallback = new DailyContextService(db, key, () => now).fallback(context);
    expect(fallback.items.some((item) => item.title === 'Form deadline' && item.sourceRefs.every((ref) => ref.startsWith('source-')))).toBe(true);
    expect(fallback.items.some((item) => item.title === 'Due task')).toBe(true);
    expect(fallback.coverageNotice).toContain('email coverage is stale');
    db.close();
  });
});
it('reports calendar coverage as stale when any selected calendar is behind',()=>{
  const db=seed();
  db.prepare("INSERT INTO sync_states (id,connection_id,source_kind,stream_key,query_version,generation,last_success_at,created_at,updated_at) VALUES ('cal-sync-2','c2','calendar','s2','calendar-v1',1,?,?,?)").run(new Date(now.getTime()-31*60000).toISOString(),now.toISOString(),now.toISOString());
  const service=new DailyContextService(db,key,()=>now);
  expect(service.build(actor).coverage.find(channel=>channel.channel==='calendar')?.status).toBe('stale');
  db.prepare("UPDATE sync_states SET last_success_at=? WHERE id='cal-sync-2'").run(now.toISOString());
  expect(service.build(actor).coverage.find(channel=>channel.channel==='calendar')?.status).toBe('fresh');
  db.prepare("UPDATE google_connections SET status='paused' WHERE id='c2'").run();
  expect(service.build(actor).coverage.find(channel=>channel.channel==='calendar')?.status).toBe('unavailable');db.close();
});

it('does not let raw subjects bypass email review when suggestions are enabled',()=>{
 const db=seed();source(db,'mail',{subject:'Routine delivery with a date'});
 expect(new DailyContextService(db,key,()=>now).build(actor).candidates.some(x=>x.kind==='source')).toBe(true);
 db.prepare("INSERT INTO background_ai_settings VALUES ('m1',1,'background-ai-v1',1,?)").run(now.toISOString());
 const plan=new PlanRepository(db,key,()=>now).createPrivate(actor,{title:'Reviewed appointment',category:'appointment',participants:[],preparationTasks:[],unresolvedFields:[]});
 const context=new DailyContextService(db,key,()=>now).build(actor);
 expect(context.candidates.some(x=>x.kind==='source')).toBe(false);expect(context.candidates.some(x=>x.navigation.id===plan)).toBe(true);db.close();
});

it('keeps old and undated tasks required; snoozed tasks return on their local date without reminder duplicates',()=>{
 const db=seed();const insert=db.prepare("INSERT INTO list_items (id,household_id,kind,title,due_time_json,snoozed_until,created_by,created_at,updated_at) VALUES (?,'h1','todo',?,?,?,'m1',?,?)");
 insert.run('old','Long-open task',JSON.stringify('2025-01-01'),null,now.toISOString(),now.toISOString());
 insert.run('undated','No deadline',null,null,now.toISOString(),now.toISOString());
 insert.run('later','Snoozed task',JSON.stringify('2026-03-09'),'2026-03-09',now.toISOString(),now.toISOString());
 db.prepare("INSERT INTO reminders (id,household_id,recipient_id,parent_type,parent_id,due_at,timezone,revision,state,created_by,created_at,updated_at) VALUES ('r','h1','m1','list_item','later','2026-03-09T13:00:00Z','America/New_York',1,'active','m1',?,?)").run(now.toISOString(),now.toISOString());
 const today=new DailyContextService(db,key,()=>now).build(actor);
 expect(today.candidates.some(x=>x.kind==='reminder')).toBe(false);
 expect(today.candidates.filter(x=>x.kind==='task').map(x=>[x.title,x.required])).toEqual([['Long-open task',true],['No deadline',true]]);
 db.prepare('INSERT INTO morning_dismissals VALUES (?,?,?)').run('m1',today.candidates.find(x=>x.title==='Long-open task')!.ref,now.toISOString());
 expect(new DailyContextService(db,key,()=>now).build(actor).candidates.some(x=>x.title==='Long-open task')).toBe(true);
 const next=new DailyContextService(db,key,()=>new Date('2026-03-09T04:00:00Z')).build(actor);
 expect(next.candidates.find(x=>x.title==='Snoozed task')).toMatchObject({required:true,state:'open'});db.close();
});
