import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { EmailConnection, ImapPreset } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { EmailSettings, guessPreset } from './EmailSettings.js';

vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

const presets: ImapPreset[] = [
  { id: 'gmail', label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, help: 'https://myaccount.google.com/apppasswords', note: 'Needs 2-Step Verification, then an app password.' },
  { id: 'icloud', label: 'iCloud Mail', host: 'imap.mail.me.com', port: 993, secure: true, help: 'https://support.apple.com/en-us/102654', note: 'Use an app-specific password from your Apple Account.' },
  { id: 'fastmail', label: 'Fastmail', host: 'imap.fastmail.com', port: 993, secure: true, help: 'https://www.fastmail.help/hc/en-us/articles/360058752854', note: 'Create an app password with IMAP access.' },
  { id: 'other', label: 'Other (IMAP)', host: '', port: 993, secure: true, help: null, note: 'Your provider’s IMAP server name, usually imap.<your domain>.' },
];
const disconnected: EmailConnection = { connected: false, status: 'disconnected', revision: 0 };
const active: EmailConnection = { connected: true, status: 'active', provider: 'imap', email: 'alex@icloud.com', revision: 4, syncLastSuccessAt: null, syncErrorCode: null };
type Handler = (path: string, init?: RequestInit) => unknown;

function serve(connection: EmailConnection, extra: Handler = () => undefined) {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const handled = await extra(path, init);
    if (handled !== undefined) return handled;
    if (path === '/connection') return { data: connection };
    if (path === '/connection/imap/presets') return { data: presets };
    throw new Error(`unexpected ${path}`);
  });
}
const lastBody = (path: string) => JSON.parse(String(vi.mocked(apiFetch).mock.calls.filter(([callPath]) => callPath === path).at(-1)![1]!.body)) as Record<string, unknown>;

it('prefills server details from the chosen provider and guesses it from the address', async () => {
  serve(disconnected);
  render(<EmailSettings />);
  const provider = await screen.findByLabelText('Email provider');
  expect(provider).toHaveValue('gmail');
  expect(screen.getByText(/Needs 2-Step Verification/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'How to make an app password for Gmail' })).toHaveAttribute('href', 'https://myaccount.google.com/apppasswords');
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'alex@icloud.com' } });
  expect(provider).toHaveValue('icloud');
  expect(screen.getByLabelText('Mail server')).toHaveValue('imap.mail.me.com');
  expect(screen.getByLabelText('Username')).toHaveAttribute('placeholder', 'alex@icloud.com');
  fireEvent.change(provider, { target: { value: 'fastmail' } });
  expect(screen.getByLabelText('Mail server')).toHaveValue('imap.fastmail.com');
  fireEvent.change(provider, { target: { value: 'other' } });
  expect(screen.getByLabelText('Mail server')).toHaveValue('');
  expect(screen.queryByText('Server settings')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /How email connection works/ })).toHaveAttribute('href', 'https://github.com/ravimody/fridgedoor/blob/main/docs/email.md');
});

it('explains test failures in plain language and sends the address as the username', async () => {
  serve(disconnected, (path) => { if (path === '/connection/imap/test') throw new Error('IMAP_AUTH_FAILED'); });
  render(<EmailSettings />);
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'alex@gmail.com' } });
  fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'abcd efgh ijkl mnop' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('app password wasn’t accepted');
  expect(lastBody('/connection/imap/test')).toEqual({ email: 'alex@gmail.com', credentials: { host: 'imap.gmail.com', port: 993, secure: true, username: 'alex@gmail.com', password: 'abcd efgh ijkl mnop', mailbox: 'INBOX' } });
});

it.each([['IMAP_UNREACHABLE', 'Couldn’t reach that mail server'], ['IMAP_TIMEOUT', 'took too long'], ['IMAP_TLS_FAILED', 'secure connection'], ['IMAP_MAILBOX_NOT_FOUND', 'folder doesn’t exist'], ['IMAP_FAILED', 'turned the connection down']])('maps %s', async (code, text) => {
  serve(disconnected, (path) => { if (path === '/connection/imap/test') throw new Error(code); });
  render(<EmailSettings />);
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'alex@gmail.com' } });
  fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(text);
});

it('asks for agreement, then connects and shows the mailbox', async () => {
  const onConnected = vi.fn();
  serve(disconnected, (path) => path === '/connection/imap' ? { data: { ...active, email: 'alex@gmail.com' } } : undefined);
  render(<EmailSettings onConnected={onConnected} />);
  fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'alex@gmail.com' } });
  fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Tick the box above');
  fireEvent.click(screen.getByLabelText(/reviewed what is read, shared, retained/));
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(await screen.findByText('alex@gmail.com')).toBeVisible();
  expect(screen.getByText('Checking for new email')).toBeVisible();
  expect(lastBody('/connection/imap')).toMatchObject({ email: 'alex@gmail.com', disclosureVersion: 'v1' });
  expect(onConnected).toHaveBeenCalled();
});

it('asks for a new app password when the old one stops working', async () => {
  const fixed = { ...active, status: 'active', revision: 5 };
  serve({ ...active, status: 'needs_reauth', syncErrorCode: 'IMAP_AUTH_FAILED' }, (path) => path === '/connection/imap' ? { data: fixed } : undefined);
  render(<EmailSettings />);
  expect(await screen.findByRole('alert')).toHaveTextContent('app password for alex@icloud.com stopped working');
  expect(screen.getByText('Needs a new app password')).toBeVisible();
  expect(screen.getByLabelText('Email provider')).toHaveValue('icloud');
  expect(screen.getByLabelText('Email address')).toHaveValue('alex@icloud.com');
  fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'new-app-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save new password' }));
  expect(await screen.findByText('Thanks, your email is connected again.')).toBeVisible();
  expect(lastBody('/connection/imap')).toMatchObject({ email: 'alex@icloud.com', credentials: { host: 'imap.mail.me.com', password: 'new-app-password' } });
  expect(screen.getByText('Checking for new email')).toBeVisible();
});

it('pauses with the current revision and disconnects after confirming', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  serve(active, (path) => path === '/connection/pause' ? { data: { ...active, status: 'paused', revision: 5 } } : path === '/connection/disconnect' ? { data: disconnected } : undefined);
  render(<EmailSettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(await screen.findByRole('button', { name: 'Resume' })).toBeVisible();
  expect(lastBody('/connection/pause')).toEqual({ expectedRevision: 4 });
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(await screen.findByText(/no longer reads your email/)).toBeVisible();
  expect(lastBody('/connection/disconnect')).toEqual({ expectedRevision: 5 });
  expect(screen.getByLabelText('Email provider')).toBeVisible();
});

it('deletes private data after confirming', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  let current = active;
  serve(active, (path, init) => { if (path === '/connection/private-data') { current = disconnected; return { data: { deleted: true } }; } if (path === '/connection' && current === disconnected) return { data: current }; void init; return undefined; });
  render(<EmailSettings />);
  fireEvent.click(await screen.findByText('Delete my private data', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete my private data' }));
  expect(await screen.findByText('Your private data was deleted.')).toBeVisible();
  expect(lastBody('/connection/private-data')).toEqual({ confirm: true });
});

it('offers Google to everyone only when the server says it is set up', async () => {
  serve(disconnected);
  render(<EmailSettings />);
  await screen.findByLabelText('Email provider');
  expect(screen.queryByText(/Advanced: connect with Google/)).not.toBeInTheDocument();
  cleanup();

  serve({ ...disconnected, googleAvailable: true });
  render(<EmailSettings />);
  expect(await screen.findByText(/Advanced: connect with Google/)).toBeVisible();
  // Members never probe the owner-only server settings.
  expect(new Set(vi.mocked(apiFetch).mock.calls.map(([path]) => path))).toEqual(new Set(['/connection', '/connection/imap/presets']));
});

it('explains a Google start that the server refuses', async () => {
  serve({ ...disconnected, googleAvailable: true }, (path) => { if (path === '/connection/google/start') throw new Error('GOOGLE_NOT_CONFIGURED'); });
  render(<EmailSettings />);
  fireEvent.click(await screen.findByText(/Advanced: connect with Google/));
  fireEvent.click(screen.getByLabelText(/reviewed what is read, shared, retained/));
  fireEvent.click(screen.getByRole('button', { name: 'Connect with Google' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in isn’t set up on this server');
});

it('recognises common providers from the address', () => {
  expect(guessPreset('Sam@GMAIL.com')).toBe('gmail');
  expect(guessPreset('sam@me.com')).toBe('icloud');
  expect(guessPreset('sam@example.org')).toBeUndefined();
});
