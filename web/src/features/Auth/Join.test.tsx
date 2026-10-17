import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Member } from '@fridgedoor/contracts';
import { publicFetch, startSession } from '../../api/client.js';
import { JoinPage } from './Join.js';

vi.mock('../../api/client.js', () => ({ publicFetch: vi.fn(), startSession: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const sam: Member = { id: 'm2', householdId: 'h1', displayName: 'Sam', timezone: 'America/Chicago' };

function renderJoin(onSignedIn = vi.fn()) {
  render(<MemoryRouter initialEntries={['/join/invite-token']}><Routes><Route path="/join/:token" element={<JoinPage onSignedIn={onSignedIn} onSignOut={vi.fn()} />} /><Route path="/" element={<p>Home screen</p>} /></Routes></MemoryRouter>);
  return onSignedIn;
}

it('shows who sent the invite and creates the account', async () => {
  vi.mocked(publicFetch).mockResolvedValue({ data: { householdName: 'The Riveras', invitedBy: 'Alex' } });
  vi.mocked(startSession).mockResolvedValue(sam);
  const onSignedIn = renderJoin();
  expect(await screen.findByRole('heading', { name: 'Join The Riveras' })).toBeVisible();
  expect(screen.getByText(/Alex invited you/)).toBeVisible();
  expect(screen.getByText(/in Safari, tap Share, then Add to Home Screen/)).toBeVisible();
  expect(publicFetch).toHaveBeenCalledWith('/auth/invites/invite-token');
  await waitFor(() => expect(screen.getByLabelText('Your name')).toHaveFocus());
  expect(screen.getByLabelText('Your name')).toHaveAttribute('autocomplete', 'name');
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'another long one' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'another long one' } });
  fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/Chicago' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join The Riveras' }));
  expect(await screen.findByText('Home screen')).toBeVisible();
  expect(startSession).toHaveBeenCalledWith('/auth/invites/invite-token', { displayName: 'Sam', email: 'sam@example.test', password: 'another long one', timezone: 'America/Chicago' });
  expect(onSignedIn).toHaveBeenCalledWith(sam);
});

it('explains an expired or used invite', async () => {
  vi.mocked(publicFetch).mockRejectedValue(new Error('INVITE_INVALID'));
  renderJoin();
  expect(await screen.findByRole('heading', { name: 'This invite has expired' })).toBeVisible();
  expect(screen.getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', '/login');
});

it('rejects a short password before contacting the server', async () => {
  vi.mocked(publicFetch).mockResolvedValue({ data: { householdName: 'The Riveras', invitedBy: 'Alex' } });
  renderJoin();
  await screen.findByRole('heading', { name: 'Join The Riveras' });
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Sam' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
  fireEvent.click(screen.getByRole('button', { name: 'Join The Riveras' }));
  expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters');
  expect(startSession).not.toHaveBeenCalled();
});
