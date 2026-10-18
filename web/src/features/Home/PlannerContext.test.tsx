import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { PlannerProvider, usePlanner } from './PlannerContext.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../Settings/notification-worker.js', () => ({ registerNotificationWorker: vi.fn().mockResolvedValue(undefined) }));
const setHidden = (hidden: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
const reads = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => !init?.method).length;
function Notice() { return <p>{usePlanner().notice || 'No notice'}</p>; }
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('crypto', { ...crypto, randomUUID: () => 'client' }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); setHidden(false); });

it('returns to sign-in when the session has expired instead of reporting a refresh failure', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('AUTH_REQUIRED'));
  const onExpired = vi.fn();
  render(<PlannerProvider timezone="UTC" onExpired={onExpired}><Notice /></PlannerProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(onExpired).toHaveBeenCalled();
  expect(screen.getByText('No notice')).toBeInTheDocument();
});

it('still reports other refresh failures', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('API_500'));
  render(<PlannerProvider timezone="UTC" onExpired={vi.fn()}><Notice /></PlannerProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText(/Could not refresh/)).toBeInTheDocument();
});

it('pauses polling while the page is hidden and refreshes when it is shown again', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ data: [] });
  render(<PlannerProvider timezone="UTC"><Notice /></PlannerProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const initial = reads();
  expect(initial).toBeGreaterThan(0);
  setHidden(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads()).toBe(initial);
  setHidden(false);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
  expect(reads()).toBeGreaterThan(initial);
});

it('keeps the session when an action is refused with 403 FORBIDDEN', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => { if (init?.method === 'DELETE') throw new Error('FORBIDDEN'); return { data: [] }; });
  const onExpired = vi.fn();
  function Refused() { const planner = usePlanner(); return <><button onClick={() => void planner.act(() => apiFetch('/admin/ai', { method: 'DELETE' }))}>Try</button><p>{planner.notice || 'No notice'}</p></>; }
  render(<PlannerProvider timezone="UTC" onExpired={onExpired}><Refused /></PlannerProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { screen.getByRole('button', { name: 'Try' }).click(); await vi.advanceTimersByTimeAsync(0); });
  expect(onExpired).not.toHaveBeenCalled();
  expect(screen.getByText(/isn’t allowed for your account/)).toBeInTheDocument();
});

it.each([
  ['PROPOSAL_EXPIRED', /This suggestion expired/],
  ['CAPTURE_STORAGE_FULL', /still waiting to be read/],
  ['PAYLOAD_TOO_LARGE', /too long to send/],
  ['INTERNAL', /Something went wrong. Try again in a moment/],
])('explains a refused action with %s', async (code, text) => {
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => { if (init?.method === 'POST') throw new Error(code); return { data: [] }; });
  function Refused() { const planner = usePlanner(); return <><button onClick={() => void planner.act(() => apiFetch('/assistant/runs', { method: 'POST' }))}>Try</button><p>{planner.notice || 'No notice'}</p></>; }
  render(<PlannerProvider timezone="UTC"><Refused /></PlannerProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { screen.getByRole('button', { name: 'Try' }).click(); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText(text)).toBeInTheDocument();
});

it('points to To do actions when the server refuses to dismiss a task item', async () => {
  const overview = { state: 'ready', result: { summary: 'Today.', items: [], questions: [], omittedRefs: [] }, items: [], generatedAt: null, coverage: [], revision: 1 };
  vi.mocked(apiFetch).mockImplementation(async (path) => { if (path === '/daily-overview/dismiss') throw new Error('TASK_REQUIRES_ACTION'); return { data: path === '/daily-overview' ? overview : [] }; });
  function Dismiss() { const planner = usePlanner(); return <><button onClick={() => void planner.dismissMorningItem(['todo-1'], 1)}>Dismiss</button><p>{planner.notice || 'No notice'}</p></>; }
  render(<PlannerProvider timezone="UTC"><Dismiss /></PlannerProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { screen.getByRole('button', { name: 'Dismiss' }).click(); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('This is a to-do. Mark it done or choose Later instead.')).toBeInTheDocument();
});
