import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, vi, it, expect } from 'vitest';
import { bootstrap, fetchAuthStatus } from '../api/client.js';
import { App } from './App.js';
vi.mock('../api/client.js', () => ({ bootstrap: vi.fn().mockResolvedValue({ id: 'm1', householdId: 'h1', displayName: 'Alex', timezone: 'America/New_York' }), fetchAuthStatus: vi.fn(), publicFetch: vi.fn(), startSession: vi.fn(), apiFetch: vi.fn(async (path: string) => ({ data: path === '/plans' ? { plans: [] } : path === '/agenda' || path.startsWith('/lists/') ? { items: [] } : path === '/reminders' ? { reminders: [] } : path === '/assistant/settings' ? { enabled: true, consent: false } : path === '/connection' ? { status: 'disconnected' } : path === '/destination' ? null : path === '/household' ? { name: 'The Riveras', canManage: false, members: [{ id: 'm1', displayName: 'Alex', active: true, role: 'member', email: 'alex@example.test' }], invites: [] } : path === '/calendar-feed' ? { active: false, createdAt: null, lastFetchedAt: null } : [] })), clearClientSession: vi.fn(), logout: vi.fn() }));
Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open'); } });
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });
const signedOut = (setupRequired: boolean, accessMode = false) => {
  vi.mocked(bootstrap).mockRejectedValueOnce(new Error('AUTH_REQUIRED'));
  vi.mocked(fetchAuthStatus).mockResolvedValueOnce({ setupRequired, accessMode, publicUrl: 'http://localhost:3000' });
};

it('has four primary destinations and a single persistent input', async () => {
  render(<BrowserRouter><App /></BrowserRouter>);
  expect(await screen.findByRole('heading', { name: /A little planning/ })).toBeVisible();
  const links = within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link');
  expect(links.map((link) => link.textContent)).toEqual(['Home', 'To do', 'Groceries', 'More']);
  expect(screen.getAllByRole('button', { name: 'Ask, add, or share…' })).toHaveLength(1);
});

it('sends a signed-out deep link to the sign-in page', async () => {
  signedOut(false);
  window.history.replaceState(null, '', '/plans');
  render(<BrowserRouter><App /></BrowserRouter>);
  expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(window.location.pathname).toBe('/login');
  expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
});

it('starts setup on a fresh server', async () => {
  signedOut(true);
  render(<BrowserRouter><App /></BrowserRouter>);
  expect(await screen.findByRole('heading', { name: 'Open your setup link' })).toBeVisible();
  expect(window.location.pathname).toBe('/setup');
});

it('opens the setup form from the setup link', async () => {
  signedOut(true);
  window.history.replaceState(null, '', '/setup?token=setup-token-abcdefghijkl');
  render(<BrowserRouter><App /></BrowserRouter>);
  expect(await screen.findByLabelText('Household name')).toBeVisible();
});

it('offers a retry when the server cannot be reached', async () => {
  vi.mocked(bootstrap).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  vi.mocked(fetchAuthStatus).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  render(<BrowserRouter><App /></BrowserRouter>);
  expect(await screen.findByRole('heading', { name: 'Can’t reach Fridgedoor' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
});

it('opens Settings from the profile menu and its pages by address', async () => {
  render(<BrowserRouter><App /></BrowserRouter>);
  fireEvent.click(within(await screen.findByRole('banner')).getByRole('link', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  fireEvent.click(screen.getByRole('link', { name: /^Account/ }));
  expect(window.location.pathname).toBe('/settings/account');
  expect(await screen.findByRole('heading', { name: 'Profile' })).toBeVisible();
  cleanup();

  window.history.replaceState(null, '', '/settings/household');
  render(<BrowserRouter><App /></BrowserRouter>);
  expect(await screen.findByRole('heading', { name: 'Household', level: 1 })).toBeVisible();
  expect(await screen.findByText('The Riveras')).toBeVisible();
});
