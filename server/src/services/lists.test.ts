import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { ListService } from './lists.js';
import { ChatService } from '../ai/chat.js';
const now = new Date('2026-01-01T00:00:00.000Z');
function seed() { const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now.toISOString()); db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m1', 'h1', 's1', 'Alex', 'America/New_York', 1, now.toISOString()); return db; }
describe('household lists and private chat', () => {
  it('replays list creation and detects stale edits', () => { const db = seed(); const service = new ListService(db, keyFromSecret('list-secret'), () => now); const actor = { memberId: 'm1', householdId: 'h1' }; const first = service.create(actor, 'grocery', 'Milk', undefined, undefined, undefined, 'k1'); expect(service.create(actor, 'grocery', 'Milk', undefined, undefined, undefined, 'k1')).toEqual(first); expect(() => service.update(actor, first.id, 1, { completed: true })).not.toThrow(); expect(() => service.update(actor, first.id, 1, { completed: false })).toThrow('STALE_REVISION'); });
  it('keeps chat threads private, answers authorized list questions, and creates typed proposals', () => { const db = seed(); const lists = new ListService(db, keyFromSecret('chat-secret'), () => now); const chat = new ChatService(db, keyFromSecret('chat-secret'), lists, () => now); const actor = { memberId: 'm1', householdId: 'h1' }; const thread = chat.create(actor); const result = chat.message(actor, thread.threadId, 'add paper towels'); expect(result.proposals[0]?.state).toBe('pending'); expect(result.messages.at(-1)?.text).toMatch(/prepared/i); expect(lists.list(actor, 'todo')).toHaveLength(0); const applied = chat.apply(actor, thread.threadId, result.proposals[0]!.id, 'chat-apply-1'); expect(applied.title).toBe('paper towels'); expect(chat.apply(actor, thread.threadId, result.proposals[0]!.id, 'chat-apply-1')).toEqual(applied); expect(lists.list(actor, 'todo')).toHaveLength(1); const answer = chat.message(actor, thread.threadId, 'what is on my todo list?'); expect(answer.messages.at(-1)?.text).toContain('paper towels'); });
});

it('snoozes a task atomically, moves its reminder date, and rejects stale or invalid changes',()=>{
 const db=seed(),actor={memberId:'m1',householdId:'h1'},key=keyFromSecret('list-secret');
 const service=new ListService(db,key,()=>now),item=service.create(actor,'todo','Contact workshop host',undefined,'m1','2025-12-29','task');
 db.prepare("INSERT INTO reminders (id,household_id,recipient_id,parent_type,parent_id,due_at,timezone,revision,state,created_by,created_at,updated_at) VALUES ('r','h1','m1','list_item',?,'2025-12-29T14:00:00Z','America/New_York',1,'expired','m1',?,?)").run(item.id,now.toISOString(),now.toISOString());
 const updated=service.snooze(actor,item.id,item.revision,'2026-01-03');
 expect(updated).toMatchObject({dueTime:'2026-01-03',snoozedUntil:'2026-01-03',completedAt:null,revision:2});
 expect(db.prepare('SELECT due_at,state,revision FROM reminders').get()).toEqual({due_at:'2026-01-03T14:00:00.000Z',state:'active',revision:2});
 expect(()=>service.snooze(actor,item.id,1,'2026-01-05')).toThrow('STALE_REVISION');
 for(const date of ['2025-12-30','2026-02-30','invalid']) expect(()=>service.snooze(actor,item.id,2,date)).toThrow('INVALID_SNOOZE_DATE');
 service.update(actor,item.id,2,{completed:true});expect(()=>service.snooze(actor,item.id,3,'2026-01-05')).toThrow('TASK_NOT_OPEN');db.close();
});


it('clears snooze when rescheduling or clearing a task date, but preserves it on unrelated edits',()=>{
 const db=seed(), actor={memberId:'m1',householdId:'h1'}, service=new ListService(db,keyFromSecret('list-secret'),()=>now);
 const task=service.create(actor,'todo','Call workshop host',undefined,undefined,'2026-01-01','reschedule');
 let item=service.snooze(actor,task.id,task.revision,'2026-01-07');
 item=service.update(actor,item.id,item.revision,{title:'Call host'});
 expect(item.snoozedUntil).toBe('2026-01-07');
 item=service.update(actor,item.id,item.revision,{dueTime:'2026-01-02'});
 expect(item.dueTime).toBe('2026-01-02');expect(item.snoozedUntil).toBeUndefined();
 item=service.snooze(actor,item.id,item.revision,'2026-01-07');
 item=service.update(actor,item.id,item.revision,{dueTime:null});
 expect(item.dueTime).toBeUndefined();expect(item.snoozedUntil).toBeUndefined();db.close();
});
