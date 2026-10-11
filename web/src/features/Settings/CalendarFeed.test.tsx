import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { CalendarFeed } from './CalendarFeed.js';

vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });
const created = { active: true, url: 'https://fridgedoor.example.test/calendar/v1/secret-token.ics', webcalUrl: 'webcal://fridgedoor.example.test/calendar/v1/secret-token.ics' };

function serve(active: boolean) {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path !== '/calendar-feed') throw new Error(`unexpected ${path}`);
    if (init?.method === 'POST') return { data: created };
    if (init?.method === 'DELETE') return { data: { active: false } };
    return { data: active ? { active: true, createdAt: '2026-10-01T12:00:00.000Z', lastFetchedAt: '2026-10-10T12:00:00.000Z' } : { active: false, createdAt: null, lastFetchedAt: null } };
  });
}

it('makes a link to add to Apple Calendar, copy, or paste into Google and Outlook', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  serve(false);
  const onCreated = vi.fn();
  render(<CalendarFeed onCreated={onCreated} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Make my calendar link' }));
  expect(await screen.findByRole('link', { name: 'Add to Apple Calendar' })).toHaveAttribute('href', created.webcalUrl);
  expect(screen.getByLabelText('Your calendar link')).toHaveValue(created.url);
  expect(screen.getByText(/Other calendars/)).toBeVisible();
  expect(screen.getByText(/Subscribe from web/)).toBeVisible();
  expect(screen.getByText(/Keep it private, like a password/)).toBeVisible();
  expect(screen.getByText(/every hour or so; Google Calendar can take longer/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(created.url));
  expect(onCreated).toHaveBeenCalled();
});

it('replaces an existing link only after warning, and turns it off', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  serve(true);
  render(<CalendarFeed />);
  expect(await screen.findByText(/Your calendar link is on/)).toBeVisible();
  expect(screen.queryByLabelText('Your calendar link')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
  expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/current link stops working/));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
  expect(await screen.findByText('Calendar link turned off.')).toBeVisible();
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/calendar-feed', { method: 'DELETE' });
  expect(screen.getByRole('button', { name: 'Make my calendar link' })).toBeVisible();
});
