import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Household } from './Household.js';
import { post, usePlanner } from './PlannerContext.js';
vi.mock('./PlannerContext.js', () => ({ usePlanner: vi.fn(), post: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const soon = new Date(Date.now() + 60_000).toISOString();

it('calls an upkeep archive "Archived" and offers its Undo', () => {
  const act = vi.fn(async (action: () => Promise<unknown>) => { await action(); return true; });
  vi.mocked(usePlanner).mockReturnValue({
    timezone: 'America/New_York', busy: false, act, settings: { consent: false }, knowledge: [],
    knowledgeProposals: [{ id: 'p1', operation: 'archive', targetKeys: ['soccer_season'], baseRevisions: [1], proposedValue: null, provenanceRefs: [], reason: 'The season ended.', status: 'pending', createdAt: soon, expiresAt: soon }],
    knowledgeHistory: [{ id: 'c1', key: 'school_term', baseRevision: 1, resultRevision: 2, before: 'Fall term until Dec 19', after: 'Fall term until Dec 19', origin: 'maintenance', reason: 'maintenance-expiry', createdAt: soon, undoUntil: soon }],
  } as unknown as ReturnType<typeof usePlanner>);
  render(<Household />);
  expect(screen.getByText('Archived', { selector: 'span' })).toBeVisible();
  expect(screen.queryByText(/Forgotten/)).not.toBeInTheDocument();
  expect(screen.getByText(/Archived · Fall term until Dec 19/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(post).toHaveBeenCalledWith('/assistant/knowledge/history/c1/undo', { expectedRevision: 2 });
});
