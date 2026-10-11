import { expect, it } from 'vitest';
import { calendarOutcome, requestOutcomes, type AssistantRun, type PlanSummary } from '@fridgedoor/contracts';
const run: AssistantRun = { id: 'r', text: 'fixture', state: 'succeeded', createdAt: '2026-09-13T12:00:00Z', captureId: null, applied: false, planIds: [], errorCode: null, feedback: null, metrics: null, result: { reply: 'A reply', items: [], knowledge: [], sources: [], assumptions: [], followups: [] } };
const event = { kind: 'event' as const, title: 'Gathering', quantity: null, start: null, end: null, location: null, notes: null };
it('does not ask for approval on a plain reply, and reports processing/failure honestly', () => {
  expect(requestOutcomes(run)).toEqual(['reply']);
  expect(requestOutcomes({ ...run, state: 'running' })).toEqual(['working']);
  expect(requestOutcomes({ ...run, state: 'failed' })).toEqual(['needs_attention']);
});
it('keeps a mixed list addition and event proposal visible as separate outcomes', () => {
  const mixed = { ...run, result: { ...run.result!, items: [{ ...event, kind: 'grocery' as const }, event] }, reviews: [{ target: 'item:0', state: 'saved' as const, planId: null, automatic: true }] };
  expect(requestOutcomes(mixed)).toEqual(['needs_review','added']);
  expect(requestOutcomes({ ...mixed, reviews: [{ ...mixed.reviews[0]!, state: 'dismissed', undoneAt: '2026-09-13T12:00:01Z' }] })).toEqual(['needs_review','undone']);
});
it('distinguishes kept events from queued, confirmed and failed calendar writes', () => {
  const saved = { ...run, result: { ...run.result!, items: [event] }, reviews: [{ target: 'item:0', state: 'kept' as const, planId: 'p' }] };
  expect(requestOutcomes(saved)).toEqual(['saved']);
  const requested = { ...saved, reviews: [{ ...saved.reviews[0]!, state: 'calendar' as const }] };
  expect(requestOutcomes(requested)).toEqual(['calendar_pending']);
  for (const [state, expected] of [['pending','calendar_pending'],['succeeded','calendar_added'],['conflict','needs_attention'],['needs_reauth','needs_attention'],['failed','needs_attention']]) {
    expect(requestOutcomes(requested, [{ id: 'p', calendarAction: { state, kind: 'create' } } as PlanSummary])).toEqual([expected]);
  }
  expect(calendarOutcome({ state: 'succeeded', kind: 'cancel' })).toBe('calendar_removed');
  expect(calendarOutcome({ state: 'succeeded', kind: 'update' })).toBe('calendar_updated');
});
it('retains confirmed removal when an archived plan is absent from the active plan list', () => {
  expect(requestOutcomes({ ...run, result: { ...run.result!, items: [event] }, reviews: [{ target: 'item:0', state: 'calendar', planId: 'archived', calendarAction: { state: 'succeeded', kind: 'cancel' } }] })).toEqual(['calendar_removed']);
});
