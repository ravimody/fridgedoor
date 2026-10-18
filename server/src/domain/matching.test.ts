import { describe, expect, it } from 'vitest';
import { materialFingerprint, matchPlan } from './matching.js';
import type { PlanFacts } from '@fridgedoor/contracts';

const facts = (startDate: string, location = 'Library'): PlanFacts => ({ title: 'School pickup', category: 'school', participants: ['Alex'], time: { kind: 'all_day', startDate, endDateExclusive: startDate === '2026-01-01' ? '2026-01-02' : '2026-01-03' }, location, preparationTasks: [], unresolvedFields: [] });
describe('suggestion matching', () => {
  it('keeps same-title events on different days distinct', () => {
    const row = { id: 'p1', visibility: 'shared' as const, ownerId: null, title: 'School pickup', materialFingerprint: materialFingerprint(facts('2026-01-01')), dateKey: '2026-01-01' };
    expect(matchPlan(facts('2026-01-02'), 'shared', null, [row]).kind).toBe('none');
  });
  it('marks same-day fact changes as possible duplicates', () => {
    const row = { id: 'p1', visibility: 'shared' as const, ownerId: null, title: 'School pickup', materialFingerprint: materialFingerprint(facts('2026-01-01')), dateKey: '2026-01-01' };
    expect(matchPlan(facts('2026-01-01', 'Gym'), 'shared', null, [row])).toEqual({ kind: 'possible', planId: 'p1' });
  });
});
