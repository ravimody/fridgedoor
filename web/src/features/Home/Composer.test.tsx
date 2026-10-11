import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Composer } from './Composer.js';
import { post, usePlanner } from './PlannerContext.js';
vi.mock('./PlannerContext.js', () => ({ post: vi.fn(), usePlanner: vi.fn() }));
vi.mock('./VoiceInput.js', () => ({ VoiceInput: ({ onText }: { onText: (text: string, send: boolean) => Promise<void> }) => <><button onClick={() => void onText('Drinks Monday at six', true)}>Synthetic voice send</button><button onClick={() => void onText('Drinks Monday at six', false)}>Synthetic voice draft</button></> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });
function setup() {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); }); HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  const setComposerOpen = vi.fn();
  const planner = { runs: [], composerOpen: true, loaded: true, busy: false, settings: { enabled: true, consent: true }, setComposerOpen, setNotice: vi.fn(), act: async (fn: () => Promise<unknown>) => { try { await fn(); return true; } catch { return false; } } } as unknown as ReturnType<typeof usePlanner>;
  vi.mocked(usePlanner).mockReturnValue(planner);
  const view = render(<MemoryRouter><Composer /></MemoryRouter>);
  return { setComposerOpen, planner, view };
}
it('auto-sends the transcribed text with the current draft and keeps a stable retry ID', async () => {
  vi.mocked(post).mockRejectedValueOnce(new Error('NETWORK')).mockResolvedValueOnce({ data: { id: 'synthetic-run' } });
  setup();
  fireEvent.change(screen.getByLabelText('Message or recipe link'), { target: { value: 'Add a plan:' } });
  fireEvent.click(screen.getByText('Synthetic voice send'));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Message or recipe link')).toHaveValue('Add a plan:\nDrinks Monday at six');
  const first = vi.mocked(post).mock.calls[0]!;
  expect(first[0]).toBe('/assistant/runs');
  expect(first[1]).toMatchObject({ text: 'Add a plan:\nDrinks Monday at six' });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(post).mock.calls[1]).toEqual(first);
});
it('preserves interrupted voice input for recovery without submitting partial speech', async () => {
  setup(); fireEvent.click(screen.getByText('Synthetic voice draft'));
  await waitFor(() => expect(screen.getByLabelText('Message or recipe link')).toHaveValue('Drinks Monday at six'));
  expect(post).not.toHaveBeenCalled();
});

it('links the successful voice receipt to its exact request', async () => {
  vi.mocked(post).mockResolvedValueOnce({ data: { id: 'voice-request' } });
  const { setComposerOpen, planner, view } = setup();
  fireEvent.click(screen.getByText('Synthetic voice send'));
  await waitFor(() => expect(setComposerOpen).toHaveBeenCalledWith(false));
  planner.composerOpen = false;
  view.rerender(<MemoryRouter><Composer /></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'View request' })).toHaveAttribute('href', '/requests/voice-request');
  expect(screen.getByLabelText('Message or recipe link')).toHaveValue('');
});

it('replaces Sent with the automatic addition and exposes Undo without opening the request', async () => {
  vi.mocked(post).mockResolvedValue({ data: { id: 'voice-request' } });
  const { planner, view, setComposerOpen } = setup();
  fireEvent.click(screen.getByText('Synthetic voice send'));
  await waitFor(() => expect(setComposerOpen).toHaveBeenCalledWith(false));
  planner.composerOpen = false;
  planner.runs = [{ id: 'voice-request', text: 'Add beans', state: 'succeeded', createdAt: '2026-09-13T12:00:00Z', captureId: null, result: { reply: 'Beans', items: [{ kind: 'grocery', title: 'Beans', quantity: null, start: null, end: null, location: null, notes: null }], sources: [], assumptions: [], followups: [], knowledge: [] }, reviews: [{ target: 'item:0', state: 'saved', planId: null, automatic: true }], applied: false, planIds: [], errorCode: null, feedback: null, metrics: null }];
  view.rerender(<MemoryRouter><Composer /></MemoryRouter>);
  expect(screen.getByText(/Added Beans/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/assistant/runs/voice-request/undo', { index: 0 }));
});
