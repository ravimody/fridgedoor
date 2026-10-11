import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HouseholdDetails } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { SessionContext } from '../../app/session.js';
import { AccountSection, HouseholdSection } from './Account.js';

vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
const member = { id: 'm1', householdId: 'h1', displayName: 'Alex', timezone: 'UTC' };
let household: HouseholdDetails;
const signOut = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  household = { name: 'The Riveras', canManage: true, members: [{ id: 'm1', displayName: 'Alex', active: true, role: 'owner', email: 'alex@example.test' }, { id: 'm2', displayName: 'Sam', active: true, role: 'member', email: 'sam@example.test' }], invites: [{ id: 'i0', createdAt: '2026-10-10T12:00:00.000Z', expiresAt: '2026-10-17T12:00:00.000Z' }] };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const method = init?.method ?? 'GET';
    if (path === '/household' && method === 'GET') return { data: household };
    if (path === '/household/invites' && method === 'POST') { household = { ...household, invites: [...household.invites, { id: 'i1', createdAt: '2026-10-11T12:00:00.000Z', expiresAt: '2026-10-18T12:00:00.000Z' }] }; return { data: { id: 'i1', url: 'https://fridgedoor.example.test/dashboard/join/new-token', expiresAt: '2026-10-18T12:00:00.000Z' } }; }
    if (path === '/household/members/m2') { household = { ...household, members: household.members.map((person) => person.id === 'm2' ? { ...person, active: false } : person) }; return { data: { active: false } }; }
    if (path === '/account/password') throw new Error('PASSWORD_INCORRECT');
    throw new Error(`unexpected ${method} ${path}`);
  });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, 'share'); vi.restoreAllMocks(); vi.resetAllMocks(); });
const renderSections = () => render(<SessionContext.Provider value={{ member, signOut }}><AccountSection /><HouseholdSection /></SessionContext.Provider>);

it('creates an invite link to copy or share and lists it as open', async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  renderSections();
  // Shown under Account and in the people list.
  expect(await screen.findAllByText('alex@example.test')).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Turn off link' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }));
  expect(await screen.findByLabelText('Invite link')).toHaveValue('https://fridgedoor.example.test/dashboard/join/new-token');
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Turn off link' })).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: 'Share…' }));
  await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://fridgedoor.example.test/dashboard/join/new-token' })));
});

it('lets the owner remove someone else but not themselves', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderSections();
  const list = (await screen.findByRole('heading', { name: 'People' })).nextElementSibling as HTMLElement;
  const rows = within(list).getAllByRole('listitem');
  expect(within(rows[0]!).queryByRole('button')).not.toBeInTheDocument();
  fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Remove' }));
  expect(await screen.findByText('Sam was removed.')).toBeVisible();
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/household/members/m2')![1]!.body))).toEqual({ active: false });
  expect(await within(rows[1]!).findByRole('button', { name: 'Restore' })).toBeVisible();
});

it('explains a wrong current password and signs out', async () => {
  renderSections();
  await screen.findAllByText('alex@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  expect(screen.getByLabelText('Current password')).toHaveFocus();
  expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'not it' } });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a brand new password' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'a brand new password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('current password isn’t right');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(signOut).toHaveBeenCalled();
});

it('hides management for members who are not owners', async () => {
  household = { ...household, canManage: false, invites: [] };
  renderSections();
  expect(await screen.findByText(/Ask the household’s owner/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Invite someone' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
});
