import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Plans } from './Plans.js';
import { ApplyPlan } from './ApplyPlan.js';

vi.mock('../../api/client.js', () => ({
  apiFetch: vi.fn().mockResolvedValue({ data: { plans: [{ id: 'p1', revision: 1, visibility: 'private', status: 'needs_details', facts: { title: 'School pickup', category: 'school', participants: ['Alex'], time: { kind: 'unresolved', missing: ['date', 'start', 'end', 'timezone'] }, preparationTasks: [], unresolvedFields: ['date', 'start', 'end', 'timezone'] }, changeKind: 'new', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sourceSummary: { kind: 'email', count: 1, available: true }, possibleDuplicate: false }] } }),
}));
describe('plans review screen', () => { it('shows owner-only review and missing time details', async () => { render(<BrowserRouter><Plans /></BrowserRouter>); expect(await screen.findByRole('heading', { name: /suggestions for your household/i })).toBeVisible(); expect(screen.getByText('Only you')).toBeVisible(); expect(screen.getByText(/missing: date, start, end, timezone/i)).toBeVisible(); expect(screen.getByRole('button', { name: /share preview/i })).toBeVisible(); }); });
describe('calendar apply', () => { it('keeps incomplete time from reaching the action route', () => { render(<ApplyPlan plan={{ id: 'p1', revision: 1, visibility: 'shared', status: 'proposed', facts: { title: 'School pickup', category: 'school', participants: ['Alex'], time: { kind: 'unresolved', missing: ['date'] }, preparationTasks: [], unresolvedFields: ['date'] }, changeKind: 'new', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', sourceSummary: { kind: 'email', count: 1, available: true }, possibleDuplicate: false }} />); expect(screen.getByRole('button', { name: /apply to calendar/i })).toBeDisabled(); }); });
