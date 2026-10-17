import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Member } from '@fridgedoor/contracts';
import { apiFetch, fetchAuthStatus, startSession } from '../../api/client.js';
import { SetupWizard } from './Setup.js';

vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn(), startSession: vi.fn(), fetchAuthStatus: vi.fn() }));
const owner: Member = { id: 'm1', householdId: 'h1', displayName: 'Alex', timezone: 'America/New_York' };
const aiSettings = { managedByEnvironment: false, current: null, presets: [{ id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: null, needsApiKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', suggested: { main: 'claude-sonnet-5-5', email: 'claude-haiku-5-5' }, note: null }] };

function Harness() {
  const [member, setMember] = useState<Member>();
  return <Routes><Route path="/setup" element={<SetupWizard member={member} setupRequired onSignedIn={setMember} />} /><Route path="/" element={<p>Home screen</p>} /></Routes>;
}
const renderAt = (path: string) => render(<MemoryRouter initialEntries={[path]}><Harness /></MemoryRouter>);
const fillHousehold = (overrides: Record<string, string> = {}) => {
  const values = { 'Household name': 'The Riveras', 'Your name': 'Alex', Email: 'alex@example.test', Password: 'correct horse battery', 'Confirm password': 'correct horse battery', ...overrides };
  for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/admin/ai') return { data: aiSettings };
    if (path === '/household/invites' && init?.method === 'POST') return { data: { id: 'i1', url: 'https://fridgedoor.example.test/dashboard/join/invite-token', expiresAt: '2026-10-18T12:00:00.000Z' } };
    if (path === '/connection') return { data: { connected: false, status: 'disconnected', revision: 0 } };
    if (path === '/connection/imap/presets') return { data: [{ id: 'gmail', label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, help: null, note: 'Needs an app password.' }] };
    if (path === '/calendar-feed' && init?.method === 'POST') return { data: { active: true, url: 'https://fridgedoor.example.test/calendar/v1/t.ics', webcalUrl: 'webcal://fridgedoor.example.test/calendar/v1/t.ics' } };
    if (path === '/calendar-feed') return { data: { active: false, createdAt: null, lastFetchedAt: null } };
    if (path === '/devices/pairing') return { data: { link: 'fridgedoor://pair?server=x&code=y', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', expiresAt: new Date(Date.now() + 600_000).toISOString() } };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('creates the household, then walks through the optional steps to Home', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.mocked(startSession).mockResolvedValue(owner);
  vi.mocked(fetchAuthStatus).mockResolvedValue({ setupRequired: false, accessMode: false, publicUrl: 'https://fridgedoor.example.test' });
  renderAt('/setup?token=setup-token-abcdefghijkl');
  expect(screen.getByLabelText('Household name')).toHaveFocus();
  expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
  expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
  expect(screen.getByLabelText('Time zone')).toHaveValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
  fillHousehold();
  fireEvent.click(screen.getByRole('button', { name: 'Create household' }));

  expect(await screen.findByRole('heading', { name: 'Choose the planner’s AI' })).toBeVisible();
  expect(startSession).toHaveBeenCalledWith('/auth/setup', { token: 'setup-token-abcdefghijkl', householdName: 'The Riveras', displayName: 'Alex', email: 'alex@example.test', password: 'correct horse battery', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  await waitFor(() => expect(screen.getByLabelText('AI provider')).toHaveFocus());
  expect(screen.getByText(/sent to/)).toHaveTextContent('Anthropic (Claude)');
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

  expect(await screen.findByRole('heading', { name: 'Connect your email' })).toBeVisible();
  await waitFor(() => expect(screen.getByLabelText(/reviewed what is read/)).toHaveFocus());
  expect(await screen.findByLabelText('Email provider')).toBeVisible();
  expect(screen.queryByText(/connect with Google/)).not.toBeInTheDocument();
  expect(screen.queryByText('Delete my private data')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

  expect(await screen.findByRole('heading', { name: 'See your plans in your calendar' })).toBeVisible();
  fireEvent.click(await screen.findByRole('button', { name: 'Make my calendar link' }));
  expect(await screen.findByRole('link', { name: 'Add to Apple Calendar' })).toHaveAttribute('href', 'webcal://fridgedoor.example.test/calendar/v1/t.ics');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  expect(await screen.findByRole('heading', { name: 'Invite your partner' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create invite link' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }));
  expect(await screen.findByLabelText('Invite link')).toHaveValue('https://fridgedoor.example.test/dashboard/join/invite-token');
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://fridgedoor.example.test/dashboard/join/invite-token'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  expect(await screen.findByRole('heading', { name: 'Put Fridgedoor on your phone' })).toBeVisible();
  expect(screen.getByText(/in Safari, tap Share, then Add to Home Screen/)).toBeVisible();
  expect(await screen.findByText('https://fridgedoor.example.test/dashboard/')).toBeVisible();
  fireEvent.click(screen.getByText('Built the iPhone app yourself?'));
  fireEvent.click(screen.getByRole('button', { name: 'Show a pairing code' }));
  expect(await screen.findByRole('img', { name: /QR code/ })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Open in the Fridgedoor app' })).toHaveAttribute('href', 'fridgedoor://pair?server=x&code=y');
  fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
  expect(await screen.findByText('Home screen')).toBeVisible();
});

it('explains where to find the setup link when it is missing', () => {
  renderAt('/setup');
  expect(screen.getByRole('heading', { name: 'Open your setup link' })).toBeVisible();
  expect(screen.getByText('fridgedoor setup-link')).toBeVisible();
  expect(screen.queryByLabelText('Household name')).not.toBeInTheDocument();
});

it('keeps the form and explains a rejected setup link', async () => {
  vi.mocked(startSession).mockRejectedValue(new Error('SETUP_TOKEN_INVALID'));
  renderAt('/setup?token=wrong-token');
  fillHousehold();
  fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This setup link isn’t valid');
  expect(screen.getByText('fridgedoor setup-link')).toBeVisible();
  expect(screen.getByLabelText('Household name')).toHaveValue('The Riveras');
});

it('checks the password confirmation before contacting the server', () => {
  renderAt('/setup?token=setup-token-abcdefghijkl');
  fillHousehold({ 'Confirm password': 'something else' });
  fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
  expect(screen.getByRole('alert')).toHaveTextContent('The two passwords don’t match.');
  expect(startSession).not.toHaveBeenCalled();
});
