import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '@fridgedoor/contracts';
import { startSession } from '../../api/client.js';
import { LoginPage, nativeNext } from './Login.js';

vi.mock('../../api/client.js', () => ({ startSession: vi.fn() }));
const member: Member = { id: 'm1', householdId: 'h1', displayName: 'Alex', timezone: 'UTC' };
const realLocation = window.location;
const assign = vi.fn();
beforeEach(() => { Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); Object.defineProperty(window, 'location', { configurable: true, value: realLocation }); });

function renderLogin(path: string, onSignedIn = vi.fn()) {
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/login" element={<LoginPage onSignedIn={onSignedIn} publicUrl="https://fridgedoor.example.test" />} /><Route path="/" element={<p>Home screen</p>} /></Routes></MemoryRouter>);
  return onSignedIn;
}
function signIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' alex@example.test ' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('sign-in', () => {
  it('labels fields for password managers and goes Home after signing in', async () => {
    vi.mocked(startSession).mockResolvedValue(member);
    const onSignedIn = renderLogin('/login');
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    signIn();
    expect(await screen.findByText('Home screen')).toBeVisible();
    expect(startSession).toHaveBeenCalledWith('/auth/login', { email: 'alex@example.test', password: 'correct horse battery' });
    expect(onSignedIn).toHaveBeenCalledWith(member);
    expect(assign).not.toHaveBeenCalled();
  });

  it('continues the iPhone app sign-in with a full page load', async () => {
    vi.mocked(startSession).mockResolvedValue(member);
    const next = '/dashboard/native/authorize?client_id=ios&state=abc';
    const onSignedIn = renderLogin(`/login?next=${encodeURIComponent(next)}`);
    expect(screen.getByText(/connect the Fridgedoor app/)).toBeVisible();
    signIn();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(next));
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it.each(['https://evil.example/dashboard/native/authorize?x=1', '//evil.example/dashboard/native/authorize?x=1', '/dashboard/settings'])('ignores other next targets (%s)', async (next) => {
    vi.mocked(startSession).mockResolvedValue(member);
    renderLogin(`/login?next=${encodeURIComponent(next)}`);
    signIn();
    expect(await screen.findByText('Home screen')).toBeVisible();
    expect(assign).not.toHaveBeenCalled();
  });

  it('announces a wrong password and too many attempts', async () => {
    vi.mocked(startSession).mockRejectedValueOnce(new Error('SIGN_IN_FAILED')).mockRejectedValueOnce(new Error('TOO_MANY_ATTEMPTS'));
    renderLogin('/login');
    signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('don’t match an account');
    signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait 15 minutes');
  });
});

it('only accepts native authorize paths as next targets', () => {
  expect(nativeNext('?next=%2Fdashboard%2Fnative%2Fauthorize%3Fa%3D1')).toBe('/dashboard/native/authorize?a=1');
  expect(nativeNext('?next=%2Fdashboard%2Fnative%2Fauthorize')).toBeUndefined();
  expect(nativeNext('?next=%2Fdashboard%2Fnative%2Fauthorizex%3Fa')).toBeUndefined();
  expect(nativeNext('')).toBeUndefined();
});
