import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { migrate } from '../db/migrate.js';
import { keyFromSecret } from '../crypto.js';
import { AssistantService } from './assistant-service.js';
import type { AgentProvider } from './agent.js';
import { PlanDecisionService } from '../services/plan-decisions.js';
import { CalendarActionService } from '../services/calendar-actions.js';
import { PlanRepository } from '../repos/plans.js';
import { FakeGoogleProvider } from '../providers/google.js';
import { JobQueue } from '../jobs/queue.js';
import type { AssistantResult } from '@fridgedoor/contracts';
const actor = { memberId: 'a', householdId: 'h' }; const other = { memberId: 'b', householdId: 'h' };
const result: AssistantResult = { reply: 'Prepared a grocery and calendar draft.', sources: [], assumptions: [], followups: [], knowledge: [], items: [{ kind: 'grocery', title: 'Beans', quantity: '2 cans', start: null, end: null, location: null, notes: null }, { kind: 'event', title: 'School fair', quantity: null, start: '2026-09-14T10:00:00-04:00', end: '2026-09-14T12:00:00-04:00', location: 'School', notes: null }] };
function setup(override?: AgentProvider) {
  const db = new Database(':memory:'); migrate(db); db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h', '2026-01-01');
  for (const id of ['a', 'b']) db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, 'h', id, id, 'America/New_York', '2026-01-01');
  const provider: AgentProvider = override ?? { async run() { return { result, metrics: { model: 'test', promptVersion: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1, tools: [] } }; } };
  const queue = new JobQueue(db); const key = keyFromSecret('test');
  const decisions = new PlanDecisionService(db, new PlanRepository(db, key), new CalendarActionService(db, key, queue, new FakeGoogleProvider()));
  const service = new AssistantService(db, key, true, provider, undefined, decisions);
  return { db, service, queue };
}
describe('interactive assistant', () => {
  it('requires per-member consent and works without Google', async () => {
    const { service, queue, db } = setup(); expect(() => service.submit(actor, 'one', 'make plans')).toThrow('CONSENT');
    service.consent(actor, true); const run = service.submit(actor, 'one', 'make plans');
    expect(service.submit(actor, 'one', 'make plans')).toEqual(run); expect(() => service.submit(actor, 'one', 'different')).toThrow('IDEMPOTENCY');
    await service.run(queue.claim(['assistant'])!); expect(service.list(actor)[0]?.state).toBe('succeeded');
    expect(db.prepare('SELECT COUNT(*) AS n FROM list_items').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 0 });
    const applied = service.apply(actor, run.id); expect(service.apply(actor, run.id)).toEqual(applied);
    expect(db.prepare('SELECT COUNT(*) AS n FROM list_items').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT visibility, owner_id FROM plans').get()).toEqual({ visibility: 'private', owner_id: 'a' });
    expect(queue.claim(['calendar_action'])).toBeUndefined();
  });
  it('denies foreign run IDs, knowledge and attachments before use', () => {
    const { service } = setup(); service.consent(actor, true); service.consent(other, true); const run = service.submit(actor, 'one', 'private');
    expect(service.list(other)).toEqual([]); expect(service.knowledge(other)).toEqual([]);
    expect(() => service.apply(other, run.id)).toThrow('NOT_FOUND'); expect(() => service.remove(other, run.id)).toThrow('NOT_FOUND');
    expect(() => service.submit(other, 'two', '', 'foreign-photo')).toThrow('NOT_FOUND');
  });
  it('discards a result after member disable', async () => {
    let finish!: (v: Awaited<ReturnType<AgentProvider['run']>>) => void;
    const { service, queue, db } = setup({ run: () => new Promise((resolve) => { finish = resolve; }) });
    service.consent(actor, true); service.submit(actor, 'one', 'private'); const pending = service.run(queue.claim(['assistant'])!);
    db.prepare("UPDATE members SET active = 0 WHERE id = 'a'").run();
    finish({ result, metrics: { model: 'test', promptVersion: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0, tools: [] } }); await pending;
    expect(db.prepare('SELECT encrypted_result FROM assistant_runs').get()).toEqual({ encrypted_result: null });
  });
  it('retains failed input, sanitizes errors, and supports retry', async () => {
    const { service, queue } = setup({ async run() { throw new Error('private text and secret'); } });
    service.consent(actor, true); const run = service.submit(actor, 'one', 'retain me'); await service.run(queue.claim(['assistant'])!);
    expect(service.list(actor)[0]).toMatchObject({ text: 'retain me', state: 'failed', errorCode: 'ASSISTANT_FAILED' });
    service.retry(actor, run.id); expect(queue.claim(['assistant'])).toBeDefined();
  });
  it('stores approved knowledge privately and supports replacement and deletion', async () => {
    const output = { ...result, items: [], knowledge: [{ operation: 'set' as const, key: 'home_area', value: 'Example town' }] };
    const { service, queue, db } = setup({ async run() { return { result: output, metrics: { model: 'test', promptVersion: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0, tools: [] } }; } });
    service.consent(actor, true); const run = service.submit(actor, 'one', 'remember'); await service.run(queue.claim(['assistant'])!);
    expect(service.knowledge(actor)).toEqual([]); service.apply(actor, run.id); expect(service.knowledge(actor)).toMatchObject([{ key: 'home_area', value: 'Example town', revision: 1, provenance: 'user', confirmation: 'confirmed' }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM assistant_knowledge').all())).not.toContain('Example town'); expect(service.knowledge(other)).toEqual([]);
    service.setKnowledge(actor, 'home_area', 'Updated town', 1); expect(service.knowledge(actor)).toMatchObject([{ key: 'home_area', value: 'Updated town', revision: 2 }]); service.forget(actor, 'home_area', 2); expect(service.knowledge(actor)).toEqual([]);
  });
});

it('reviews one item without applying the others and preserves a kept plan after request deletion', async () => {
  const { service, queue, db } = setup(); service.consent(actor, true);
  const run = service.submit(actor, 'individual', 'mixed request'); await service.run(queue.claim(['assistant'])!);
  const kept = service.review(actor, run.id, 'item', 1, 'keep');
  expect(kept.state).toBe('kept');
  expect(db.prepare('SELECT count(*) AS n FROM list_items').get()).toEqual({ n: 0 });
  expect(service.review(actor, run.id, 'item', 1, 'keep')).toEqual(kept);
  expect(new PlanRepository(db, keyFromSecret('test')).detail(kept.planId!, actor.memberId)).toMatchObject({ visibility: 'private', savedInPlanner: true, calendarAction: null });
  service.remove(actor, run.id);
  expect(db.prepare('SELECT count(*) AS n FROM plans WHERE kept_at IS NOT NULL').get()).toEqual({ n: 1 });
});
it('rolls back calendar approval without Google and rejects other members before saving', async () => {
  const { service, queue, db } = setup(); service.consent(actor, true);
  const run = service.submit(actor, 'unconnected', 'mixed request'); await service.run(queue.claim(['assistant'])!);
  expect(() => service.review(other, run.id, 'item', 0, 'save')).toThrow('NOT_FOUND');
  expect(() => service.review(actor, run.id, 'item', 1, 'calendar')).toThrow('DESTINATION_NOT_ALLOWED');
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM assistant_item_reviews').get()).toEqual({ n: 0 });
  expect(service.list(actor)[0]!.result!.items).toHaveLength(2);
  const saved = service.review(actor, run.id, 'item', 0, 'save');
  expect(service.review(actor, run.id, 'item', 0, 'save')).toEqual(saved);
  expect(db.prepare('SELECT count(*) AS n FROM list_items').get()).toEqual({ n: 1 });
  expect(() => service.apply(actor, run.id)).toThrow('RESULT_PARTIALLY_REVIEWED');
});
it('reuses a legacy batch-saved event rather than creating another plan', async () => {
  const { service, queue, db } = setup(); service.consent(actor, true);
  const run = service.submit(actor, 'legacy', 'mixed request'); await service.run(queue.claim(['assistant'])!);
  const original = service.apply(actor, run.id);
  expect(service.list(actor)[0]!.reviews).toContainEqual({ target: 'item:1', state: 'draft', planId: original.planIds[0] });
  expect(service.review(actor, run.id, 'item', 1, 'keep').planId).toBe(original.planIds[0]);
  expect(db.prepare('SELECT count(*) AS n FROM plans').get()).toEqual({ n: 1 });
});
it('does not hide an unexpired pending request behind 30 newer requests', async () => {
  const { service, queue } = setup(); service.consent(actor, true);
  for (let i = 0; i < 35; i++) { service.submit(actor, `many-${i}`, 'mixed request'); await service.run(queue.claim(['assistant'])!); }
  expect(service.list(actor)).toHaveLength(35);
});

it('applies direct list commands once, keeps calendar review, and supports owner-scoped idempotent Undo', async () => {
  const output: AssistantResult = { ...result, items: result.items.map((item) => ({ ...item, intent: 'direct' })) };
  const { service, queue, db } = setup({ async run() { return { result: output, metrics: { model: 'test', promptVersion: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0, tools: [] } }; } });
  service.consent(actor, true); const run = service.submit(actor, 'auto', 'Add beans to groceries and a school fair to my calendar');
  const job = queue.claim(['assistant'])!; await service.run(job); await service.run(job);
  expect(db.prepare('SELECT count(*) n FROM list_items').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT count(*) n FROM calendar_actions').get()).toEqual({ n: 0 });
  expect(service.list(actor)[0]!.reviews).toEqual([expect.objectContaining({ target: 'item:0', state: 'saved', automatic: true })]);
  expect(() => service.undo(other, run.id, 0)).toThrow('NOT_FOUND');
  expect(service.undo(actor, run.id, 0)).toEqual({ undone: true });
  expect(service.undo(actor, run.id, 0)).toEqual({ undone: true });
  expect(db.prepare('SELECT count(*) n FROM list_items WHERE archived_at IS NULL').get()).toEqual({ n: 0 });
  expect(service.list(actor)[0]!.reviews![0]).toMatchObject({ state: 'dismissed', undoneAt: expect.any(String) });
  service.review(actor, run.id, 'item', 0, 'save');
  expect(db.prepare('SELECT count(*) n FROM list_items WHERE archived_at IS NULL').get()).toEqual({ n: 0 });
});

it.each(['proposal', 'lookup', 'source', 'household_context'])('keeps %s suggestions pending even when the result contains list items', async (scenario) => {
  const output: AssistantResult = { ...result, sources: scenario === 'source' ? ['https://example.test/recipe'] : [], items: [{ ...result.items[0]!, intent: scenario === 'proposal' ? 'proposal' : 'direct' }] };
  const tools = scenario === 'lookup' ? ['public_lookup'] : scenario === 'household_context' ? ['household_context'] : [];
  const { service, queue, db } = setup({ async run() { return { result: output, metrics: { model: 'test', promptVersion: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0, tools } }; } });
  service.consent(actor, true); service.submit(actor, 'proposal', 'A recipe suggestion'); await service.run(queue.claim(['assistant'])!);
  expect(db.prepare('SELECT count(*) n FROM list_items').get()).toEqual({ n: 0 });
});

it('does not undo a list item another household member has changed', async () => {
  const output: AssistantResult = { ...result, items: [{ ...result.items[0]!, intent: 'direct' }] };
  const { service, queue, db } = setup({ async run() { return { result: output, metrics: { model: 'test', promptVersion: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0, tools: [] } }; } });
  service.consent(actor, true); const run = service.submit(actor, 'direct', 'Add beans'); await service.run(queue.claim(['assistant'])!);
  const { ListService } = await import('../services/lists.js'); const lists = new ListService(db, keyFromSecret('test'));
  const item = lists.list(other, 'grocery')[0]!; lists.update(other, item.id, item.revision, { quantity: '4 cans' });
  expect(() => service.undo(actor, run.id, 0)).toThrow('STALE_REVISION');
  expect(lists.list(actor, 'grocery')).toMatchObject([{ quantity: '4 cans' }]);
});

it('keeps a known event start without inventing an end, and reads legacy partial starts after request deletion', async () => {
  const output: AssistantResult = { ...result, items: [{ ...result.items[1]!, end: null }] };
  const { service, queue, db } = setup({ async run() { return { result: output, metrics: { model: 'test', promptVersion: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0, tools: [] } }; } });
  service.consent(actor, true); const run = service.submit(actor, 'partial', 'Keep a gathering tomorrow at ten'); await service.run(queue.claim(['assistant'])!);
  const receipt = service.review(actor, run.id, 'item', 0, 'keep');
  const plans = new PlanRepository(db, keyFromSecret('test'));
  expect(plans.detail(receipt.planId!, actor.memberId)).toMatchObject({ savedInPlanner: true, facts: { time: { kind: 'unresolved', startHint: output.items[0]!.start, missing: ['end'] }, unresolvedFields: ['time'] } });
  const legacy = plans.createPrivate(actor, { title: 'Legacy gathering', category: 'household', participants: [], preparationTasks: [], unresolvedFields: ['time'], notes: 'Known start: 2026-09-14T19:00:00-04:00; end needs review.' });
  service.remove(actor, run.id);
  expect(plans.detail(legacy, actor.memberId).facts.time).toEqual({ kind: 'unresolved', startHint: '2026-09-14T19:00:00-04:00', missing: ['end'] });
  expect(() => plans.detail(legacy, other.memberId)).toThrow('NOT_FOUND');
  expect(db.prepare('SELECT count(*) n FROM calendar_actions').get()).toEqual({ n: 0 });
});
