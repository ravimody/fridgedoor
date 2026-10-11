import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { SessionContext } from '../../app/session.js';
import { Settings } from './Settings.js';

vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
const member = { id: 'm1', householdId: 'h1', displayName: 'Alex', timezone: 'UTC' };
let responses: Record<string, unknown>;
const household = (canManage: boolean) => ({ name: 'The Riveras', canManage, members: [{ id: 'm1', displayName: 'Alex', active: true, role: canManage ? 'owner' : 'member', email: 'alex@example.test' }, { id: 'm2', displayName: 'Sam', active: true, role: 'member' }, { id: 'm3', displayName: 'Former', active: false, role: 'member' }], invites: [] });

beforeEach(() => {
  responses = {
    '/connection': { connected: false, status: 'disconnected', revision: 0, googleAvailable: true },
    '/connection/imap/presets': [{ id: 'gmail', label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, help: 'https://myaccount.google.com/apppasswords', note: 'Needs 2-Step Verification, then an app password.' }],
    '/household': household(false),
    '/calendar-feed': { active: false, createdAt: null, lastFetchedAt: null },
    '/source-policy': { excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false, revision: 1 },
    '/admin/ai': { managedByEnvironment: false, presets: [{ id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: null, needsApiKey: true, keyUrl: null, suggested: { main: 'claude-sonnet-5-5', email: null }, note: null }], current: { provider: 'anthropic', hasApiKey: true, baseUrl: null, models: { main: 'claude-sonnet-5-5' } } },
    '/admin/server': { publicUrl: 'https://fridgedoor.example.test', publicUrlFromEnvironment: false, google: { configured: true, fromEnvironment: false, redirectUri: 'https://fridgedoor.example.test/dashboard/google/callback' } },
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path in responses) return { data: responses[path] };
    throw new Error('UNAVAILABLE');
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function Where() { const location = useLocation(); return <output aria-label="location">{location.pathname + location.search}</output>; }
const renderAt = (path: string) => render(<SessionContext.Provider value={{ member, signOut: vi.fn() }}><MemoryRouter initialEntries={[path]}><Routes><Route path="/settings/*" element={<Settings />} /></Routes><Where /></MemoryRouter></SessionContext.Provider>);
const where = () => screen.getByLabelText('location').textContent;
const link = (name: RegExp) => screen.getByRole('link', { name });

describe('settings index', () => {
  it('lists every page with a short summary for a member', async () => {
    responses['/connection'] = { connected: true, status: 'active', provider: 'imap', email: 'alex@example.test', revision: 3, syncLastSuccessAt: new Date(Date.now() - 5 * 60_000).toISOString() };
    responses['/calendar-feed'] = { active: true, createdAt: '2026-10-01T12:00:00.000Z', lastFetchedAt: null };
    renderAt('/settings');
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['You', 'Household', 'Email & calendar', 'Apps & devices']);
    expect(await screen.findByText('alex@example.test · checked 5 min ago')).toBeVisible();
    expect(await screen.findByText('The Riveras · 2 people')).toBeVisible();
    expect(link(/^Account/)).toHaveTextContent('Alex · alex@example.test');
    expect(link(/^Calendar/)).toHaveTextContent('Calendar link on');
    expect(link(/^Email/)).toHaveAttribute('href', '/settings/email');
    for (const name of [/^Notifications/, /^iPhone/, /^Send from other apps/]) expect(link(name)).toBeVisible();
    expect(screen.queryByRole('link', { name: /^AI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Server/ })).not.toBeInTheDocument();
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith('/admin/ai');
  });

  it('adds the AI and server pages for owners', async () => {
    responses['/household'] = household(true);
    renderAt('/settings');
    expect(await screen.findByRole('link', { name: /^AI/ })).toHaveTextContent('Anthropic (Claude) · claude-sonnet-5-5');
    expect(await screen.findByText('fridgedoor.example.test · Google set up')).toBeVisible();
    expect(link(/^Email/)).toHaveTextContent('Not connected');
  });

  it('opens a page from the index and comes back', async () => {
    renderAt('/settings');
    fireEvent.click(link(/^Calendar/));
    expect(screen.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'See your plans in your calendar app' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Make my calendar link' })).toBeVisible();
    fireEvent.click(link(/Settings/));
    expect(where()).toBe('/settings');
  });

  it('sends unknown pages back to the index', () => {
    renderAt('/settings/nowhere');
    expect(where()).toBe('/settings');
  });
});

describe('settings pages', () => {
  it('keeps the mailbox, suggestions, exclusions and privacy together on Email', async () => {
    renderAt('/settings/email');
    expect(screen.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(await screen.findByRole('heading', { name: 'Connect with an app password' })).toBeVisible();
    for (const name of ['Mailbox', 'Email suggestions', 'Email privacy', 'Privacy disclosure']) expect(screen.getByRole('heading', { name })).toBeVisible();
    expect(screen.getByLabelText(/excluded senders/i)).toBeVisible();
  });

  it('requires acknowledgement before starting Google consent', async () => {
    renderAt('/settings/email');
    fireEvent.click(await screen.findByText(/Advanced: connect with Google/));
    const connect = screen.getByRole('button', { name: 'Connect with Google' });
    expect(connect).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/reviewed what is read, shared, retained/i));
    expect(connect).toBeEnabled();
  });

  it('shows the actual source, sharing, and retention limits before consent', async () => {
    renderAt('/settings/email');
    fireEvent.click(await screen.findByText(/Advanced: connect with Google/));
    expect(screen.getByText(/reads Gmail message metadata and bodies/i)).toBeVisible();
    expect(screen.getByText(/never sends, deletes or marks anything as read/i)).toBeVisible();
    expect(screen.getByText(/retained for up to 7 days/i)).toBeVisible();
    expect(screen.getByText(/server operator can access decrypted/i)).toBeVisible();
  });

  it('shows the AI editor to owners only', async () => {
    renderAt('/settings/ai');
    expect(await screen.findByText(/Only the household’s owner/)).toBeVisible();
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith('/admin/ai');
    cleanup();
    responses['/household'] = household(true);
    renderAt('/settings/ai');
    expect(await screen.findByLabelText('AI provider')).toHaveValue('anthropic');
  });
});

describe('Google consent results', () => {
  it('lands a successful connection on Calendar, where the next step is', () => {
    renderAt('/settings?oauth=success');
    expect(where()).toBe('/settings/calendar?oauth=success');
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Google connected. Choose calendars below');
  });

  it('lands a failed connection on Email with the reason', () => {
    renderAt('/settings?oauth=google_scopes_insufficient');
    expect(where()).toBe('/settings/email?oauth=google_scopes_insufficient');
    expect(screen.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible();
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Google did not grant all requested permissions');
  });
});
