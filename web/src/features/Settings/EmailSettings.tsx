import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { EmailConnection, ImapConnectInput, ImapCredentials, ImapPreset } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { errorMessage, FormError } from '../Auth/forms.js';

export const EMAIL_DOCS = 'https://github.com/ravimody/fridgedoor/blob/main/docs/email.md';
const DISCLOSURE_VERSION = 'v1';
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const imapMessages: Record<string, string> = {
  IMAP_AUTH_FAILED: 'The email address or app password wasn’t accepted. Check the address, and make sure you pasted an app password, not your usual password.',
  IMAP_UNREACHABLE: 'Couldn’t reach that mail server. Check the server name and port under “Server settings”.',
  IMAP_TIMEOUT: 'The mail server took too long to answer. Try again in a minute.',
  IMAP_TLS_FAILED: 'Couldn’t make a secure connection to the mail server. Check the port and security setting under “Server settings”.',
  IMAP_MAILBOX_NOT_FOUND: 'That folder doesn’t exist in your mailbox. Leave the folder as INBOX unless you know otherwise.',
  IMAP_FAILED: 'The mail server turned the connection down. Check the details and try again.',
  IMAP_HOST_NOT_ALLOWED: 'That server name points at this machine or a reserved address. Use your mail provider’s IMAP server.',
  TOO_MANY_ATTEMPTS: 'Too many tries in a short time. Wait a few minutes and try again.',
  CONNECTION_EXISTS: 'You’re already connected with Google. Disconnect Google first to use an app password instead.',
  VALIDATION: 'Check the email address and server settings, then try again.',
};
/** Plain-language text for an IMAP or connection error code. */
export const imapErrorMessage = (error: unknown) => errorMessage(error, imapMessages);

const domainPresets: Record<string, string> = { 'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud', 'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail', 'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'zoho.com': 'zoho', 'zohomail.com': 'zoho', 'proton.me': 'proton', 'protonmail.com': 'proton', 'pm.me': 'proton' };
/** The provider a well-known address belongs to, so most people never have to pick one. */
export const guessPreset = (email: string) => domainPresets[email.trim().toLowerCase().split('@')[1] ?? ''];

const formatWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Connects this person's mailbox: an app password (IMAP) by default, Google sign-in as the advanced
 * option. Shared by Settings and the setup wizard.
 */
export function EmailSettings({ allowGoogle = true, showDeletion = true, autoFocus = false, onConnected, onConnectionChange }: { allowGoogle?: boolean; showDeletion?: boolean; autoFocus?: boolean; onConnected?: () => void; onConnectionChange?: (connection: EmailConnection) => void }) {
  const [connection, setConnection] = useState<EmailConnection>();
  const [presets, setPresets] = useState<ImapPreset[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const loaded = Boolean(connection);
  useEffect(() => { if (autoFocus && loaded) root.current?.querySelector<HTMLElement>('input, select')?.focus(); }, [autoFocus, loaded]);

  const update = (next: EmailConnection) => { setConnection(next); onConnectionChange?.(next); };
  useEffect(() => {
    Promise.all([apiFetch<{ data: EmailConnection }>('/connection'), apiFetch<{ data: ImapPreset[] }>('/connection/imap/presets')])
      .then(([current, list]) => { update(current.data); setPresets(list.data); })
      .catch(() => setLoadError('Could not load your email settings. Reload to try again.'));
  }, []); // Loaded once; `update` only forwards to the parent.

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (caught) { setError(errorMessage(caught, { STALE_REVISION: 'Your email settings changed somewhere else. Reload the page to see the latest.', CONNECTION_NOT_FOUND: 'Your email is no longer connected. Reload the page to see the latest.', GOOGLE_NOT_CONFIGURED: 'Google sign-in isn’t set up on this server. Use an app password instead, or ask the household’s owner to set up Google under Settings → Server.' })); }
    finally { setBusy(false); }
  }
  const connectGoogle = () => run(async () => {
    const response = await apiFetch<{ data: { authorizationUrl: string } }>('/connection/google/start', json('POST', { disclosureVersion: DISCLOSURE_VERSION }));
    window.location.assign(response.data.authorizationUrl);
  });
  const transition = (action: 'pause' | 'resume' | 'disconnect') => {
    if (action === 'disconnect' && !window.confirm(connection?.provider === 'imap' ? 'Disconnect your email? Fridgedoor stops reading it right away. You can also revoke the app password at your email provider.' : 'Disconnect Google? Fridgedoor stops reading your email and calendars right away.')) return;
    void run(async () => {
      const response = await apiFetch<{ data: EmailConnection }>(`/connection/${action}`, json('POST', { expectedRevision: connection?.revision }));
      update(response.data); setChangingPassword(false);
      setNotice(action === 'pause' ? 'Paused. Fridgedoor won’t read new email until you resume.' : action === 'resume' ? 'Resumed. Fridgedoor will check for new email in the next few minutes.' : 'Disconnected. Fridgedoor no longer reads your email.');
    });
  };
  const deletePrivateData = () => {
    if (!window.confirm('Delete your private data? This can’t be undone.')) return;
    void run(async () => {
      await apiFetch('/connection/private-data', json('DELETE', { confirm: true }));
      update((await apiFetch<{ data: EmailConnection }>('/connection')).data);
      setNotice('Your private data was deleted.');
    });
  };
  const connected = (next: EmailConnection, message: string) => { update(next); setChangingPassword(false); setNotice(message); onConnected?.(); };

  if (loadError) return <p role="alert" className="form-error">{loadError}</p>;
  if (!connection) return <p role="status" className="muted">Loading your email settings…</p>;
  const isConnected = connection.connected && connection.status !== 'disconnected';
  const isImap = connection.provider === 'imap';

  return <div ref={root} className="email-settings">
    <p>Fridgedoor reads new messages in your inbox and turns school notices, invitations and appointments into suggestions. It only reads: it never sends, deletes or marks anything as read. Your mail stays private to you unless you share a suggestion. <a href={EMAIL_DOCS} target="_blank" rel="noreferrer">How email connection works</a></p>
    {notice && <p role="status" className="notice">{notice}</p>}
    <FormError message={error} />
    {isConnected ? <>
      <dl className="account-summary">
        <dt>Mailbox</dt><dd>{connection.email}</dd>
        <dt>Connected with</dt><dd>{isImap ? 'App password' : 'Google'}</dd>
        <dt>Status</dt><dd>{connection.status === 'active' ? 'Checking for new email' : connection.status === 'paused' ? 'Paused' : connection.status === 'needs_reauth' ? (isImap ? 'Needs a new app password' : 'Needs you to sign in to Google again') : connection.status}</dd>
        {connection.syncLastSuccessAt && <><dt>Last checked</dt><dd>{formatWhen(connection.syncLastSuccessAt)}</dd></>}
      </dl>
      {connection.status === 'active' && connection.syncErrorCode && isImap && <p className="field-hint">The last check didn’t work: {imapMessages[connection.syncErrorCode] ?? imapMessages.IMAP_FAILED} Fridgedoor will keep trying.</p>}
      {connection.status === 'needs_reauth' && (isImap
        ? <>
          <p role="alert" className="form-error">Your app password for {connection.email} stopped working, perhaps because it was revoked or your account password changed. Reading is paused until you enter a new one.</p>
          <ImapForm presets={presets} mode="update" initialEmail={connection.email ?? ''} onDone={(next) => connected(next, 'Thanks, your email is connected again.')} />
        </>
        : <>
          <p role="alert" className="form-error">Google needs you to sign in again before Fridgedoor can keep reading your email.</p>
          <div className="button-row"><button disabled={busy} onClick={() => void connectGoogle()}>Sign in to Google again</button></div>
        </>)}
      {isImap && connection.status !== 'needs_reauth' && (changingPassword
        ? <ImapForm presets={presets} mode="update" initialEmail={connection.email ?? ''} onDone={(next) => connected(next, 'Saved. Fridgedoor will use the new app password.')} onCancel={() => setChangingPassword(false)} />
        : <div className="button-row"><button className="secondary" disabled={busy} onClick={() => { setNotice(''); setChangingPassword(true); }}>Use a new app password</button></div>)}
      <div className="button-row">
        {connection.status === 'active' && <button className="secondary" disabled={busy} onClick={() => transition('pause')}>Pause</button>}
        {connection.status === 'paused' && <button disabled={busy} onClick={() => transition('resume')}>Resume</button>}
        <button className="secondary" disabled={busy} onClick={() => transition('disconnect')}>Disconnect</button>
      </div>
    </> : <>
      <label className="checkbox"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I have reviewed what is read, shared, retained, and sent to AI providers if enabled, and agree to connect this account.</label>
      <ImapForm presets={presets} mode="connect" accepted={accepted} onDone={(next) => connected(next, `Connected. Fridgedoor will look at your inbox in the next few minutes.`)} />
      {allowGoogle && connection.googleAvailable && <details className="advanced-option"><summary>Advanced: connect with Google instead</summary>
        <p>Google sign-in also lets Fridgedoor read your Google calendars and add events to a shared family calendar. It needs a Google Cloud project that the household’s owner sets up once; see the <a href={`${EMAIL_DOCS}#the-advanced-way-gmail-and-google-calendar-with-google-sign-in`} target="_blank" rel="noreferrer">guide</a>.</p>
        <p>Google asks for read-only Gmail access plus Calendar list and event access. The planner reads Gmail message metadata and bodies to find possible household plans; exclusions reduce processing and sharing but can’t promise that an excluded message is never read. Calendar sync starts with no calendars selected.</p>
        <button disabled={busy || !accepted} onClick={() => void connectGoogle()}>Connect with Google</button>
      </details>}
    </>}
    {showDeletion && <details className="advanced-option"><summary>Delete my private data</summary>
      <p>Deletes everything private to you: imported emails, private suggestions and plans, chats with the planner, remembered facts, your AI and morning digest settings, and automation tokens. It also disconnects your email. Plans you’ve shared with the household stay.</p>
      <button className="secondary" disabled={busy} onClick={deletePrivateData}>Delete my private data</button>
    </details>}
  </div>;
}

/** Provider, address and app password, with the server details tucked away unless they're needed. */
function ImapForm({ presets, mode, initialEmail = '', accepted = true, onDone, onCancel }: { presets: ImapPreset[]; mode: 'connect' | 'update'; initialEmail?: string; accepted?: boolean; onDone: (connection: EmailConnection) => void; onCancel?: () => void }) {
  const id = useId();
  const initial = presets.find((preset) => preset.id === (guessPreset(initialEmail) ?? 'gmail')) ?? presets[0];
  const [presetId, setPresetId] = useState(initial?.id ?? 'other');
  const [picked, setPicked] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [server, setServer] = useState({ host: initial?.host ?? '', port: String(initial?.port ?? 993), secure: initial?.secure ?? true, username: '', mailbox: 'INBOX' });
  const [result, setResult] = useState<{ ok: true } | { error: string }>();
  const [busy, setBusy] = useState<'test' | 'connect'>();
  const preset = presets.find((candidate) => candidate.id === presetId);

  const usePreset = (next: ImapPreset | undefined) => { if (!next) return; setPresetId(next.id); setServer((current) => ({ ...current, host: next.host, port: String(next.port), secure: next.secure })); setResult(undefined); };
  function credentials(): ImapCredentials | string {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return 'Enter your email address.';
    if (!password) return `Paste the app password from ${preset?.label ?? 'your provider'}.`;
    const port = Number(server.port);
    if (!server.host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) return 'Enter your provider’s mail server and port under “Server settings”.';
    return { host: server.host.trim(), port, secure: server.secure, username: server.username.trim() || email.trim(), password, mailbox: server.mailbox.trim() || 'INBOX' };
  }
  async function test() {
    const creds = credentials();
    if (typeof creds === 'string') { setResult({ error: creds }); return; }
    setBusy('test'); setResult(undefined);
    try { await apiFetch('/connection/imap/test', json('POST', { email: email.trim(), credentials: creds })); setResult({ ok: true }); }
    catch (caught) { setResult({ error: imapErrorMessage(caught) }); }
    finally { setBusy(undefined); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accepted) { setResult({ error: 'Tick the box above to agree before connecting.' }); return; }
    const creds = credentials();
    if (typeof creds === 'string') { setResult({ error: creds }); return; }
    setBusy('connect'); setResult(undefined);
    try {
      const body: ImapConnectInput = { email: email.trim(), credentials: creds, disclosureVersion: DISCLOSURE_VERSION };
      onDone((await apiFetch<{ data: EmailConnection }>('/connection/imap', json('POST', body))).data);
    } catch (caught) { setResult({ error: imapErrorMessage(caught) }); setBusy(undefined); }
  }

  const serverFields: ReactNode = <>
    <label>Mail server<input autoComplete="off" spellCheck={false} value={server.host} onChange={(event) => setServer({ ...server, host: event.target.value })} placeholder="imap.example.com" /></label>
    <div className="form-grid">
      <label>Port<input inputMode="numeric" autoComplete="off" value={server.port} onChange={(event) => setServer({ ...server, port: event.target.value })} /></label>
      <label>Security<select value={server.secure ? 'tls' : 'starttls'} onChange={(event) => setServer({ ...server, secure: event.target.value === 'tls' })}><option value="tls">SSL/TLS (usually port 993)</option><option value="starttls">STARTTLS (usually port 143)</option></select></label>
    </div>
    <label>Username<input autoComplete="off" spellCheck={false} value={server.username} onChange={(event) => setServer({ ...server, username: event.target.value })} placeholder={email.trim() || 'Same as your email address'} /></label>
    <label>Folder<input autoComplete="off" spellCheck={false} value={server.mailbox} onChange={(event) => setServer({ ...server, mailbox: event.target.value })} /></label>
  </>;
  return <form className="settings-form imap-form" onSubmit={(event) => void submit(event)} noValidate>
    {mode === 'connect' && <h3>Connect with an app password</h3>}
    <label>Email provider<select value={presetId} onChange={(event) => { setPicked(true); usePreset(presets.find((candidate) => candidate.id === event.target.value)); }}>{presets.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    {preset && <p className="field-hint" id={`${id}-note`}>{preset.note}{preset.help && <> <a href={preset.help} target="_blank" rel="noreferrer">How to make an app password for {preset.label}</a>.</>}</p>}
    <label>Email address<input type="email" inputMode="email" autoComplete="email" value={email} onChange={(event) => { setEmail(event.target.value); setResult(undefined); const guess = guessPreset(event.target.value); if (!picked && guess && guess !== presetId) usePreset(presets.find((candidate) => candidate.id === guess)); }} /></label>
    <label>App password<input type="password" autoComplete="off" spellCheck={false} value={password} onChange={(event) => { setPassword(event.target.value); setResult(undefined); }} aria-describedby={`${id}-password-hint`} /></label>
    <p className="field-hint" id={`${id}-password-hint`}>An app password only lets Fridgedoor read mail, and you can revoke it at your provider at any time without changing your real password.</p>
    {presetId === 'other' ? serverFields : <details><summary>Server settings</summary><div className="settings-form">{serverFields}</div></details>}
    {result && ('ok' in result ? <p role="status" className="notice">That worked. Fridgedoor can read your inbox.</p> : <p role="alert" className="form-error">{result.error}</p>)}
    <div className="button-row">
      <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
      <button type="submit" disabled={Boolean(busy)}>{busy === 'connect' ? 'Connecting…' : mode === 'connect' ? 'Connect' : 'Save new password'}</button>
      {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
    </div>
  </form>;
}
