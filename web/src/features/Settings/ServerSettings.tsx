import { useEffect, useState, type FormEvent } from 'react';
import type { ServerSettings as ServerSettingsData, ServerSettingsInput } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { errorMessage, FormError } from '../Auth/forms.js';

const save = (input: ServerSettingsInput) => apiFetch('/admin/server', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
const messages = { PUBLIC_URL_MANAGED_BY_ENVIRONMENT: 'The address is set in the server’s configuration, so it can’t be changed here.', VALIDATION: 'Enter a full address, like https://fridgedoor.example.com.' };

/** Owner-only: the address people use to reach Fridgedoor, and the Google OAuth client for Gmail and Calendar. */
export function ServerSettings() {
  const [settings, setSettings] = useState<ServerSettingsData>();
  const [loadError, setLoadError] = useState('');
  const load = () => apiFetch<{ data: ServerSettingsData }>('/admin/server').then((response) => setSettings(response.data));
  useEffect(() => { load().catch(() => setLoadError('Could not load server settings. Reload to try again.')); }, []);
  return <section className="card settings-card">
    {loadError && <p role="alert" className="form-error">{loadError}</p>}
    {!settings ? !loadError && <p role="status" className="muted">Loading server settings…</p> : <>
      <PublicAddress settings={settings} onSaved={() => void load().catch(() => undefined)} />
      <GoogleClient settings={settings} onSaved={() => void load().catch(() => undefined)} />
    </>}
  </section>;
}

function PublicAddress({ settings, onSaved }: { settings: ServerSettingsData; onSaved: () => void }) {
  const [publicUrl, setPublicUrl] = useState(settings.publicUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    let origin: string;
    try { origin = new URL(publicUrl.trim()).origin; } catch { setError(messages.VALIDATION); return; }
    if (origin === settings.publicUrl) return;
    if (!window.confirm(`Change Fridgedoor’s address to ${origin}? Browsers using any other address will be signed out, and new invite and setup links will use the new address.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await save({ publicUrl: origin });
      setNotice(origin === window.location.origin ? 'Address saved.' : `Address saved. From now on, open Fridgedoor at ${origin}/dashboard/.`);
      onSaved();
    } catch (caught) { setError(errorMessage(caught, messages)); }
    finally { setBusy(false); }
  }
  return <form className="settings-form" onSubmit={(event) => void submit(event)} noValidate>
    <h2>Public address</h2>
    <p>The web address your household uses to open Fridgedoor. Invite links and the iPhone app use it too.</p>
    {settings.publicUrlFromEnvironment
      ? <p className="muted">This is <strong>{settings.publicUrl}</strong>, set in the server’s configuration (PUBLIC_URL). Change it there and restart Fridgedoor.</p>
      : <>
        <label>Address<input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} /></label>
        <p className="field-hint">Changing this signs browsers out if they use a different address. Make sure the new address already reaches this server before you save.</p>
        <FormError message={error} />
        {notice && <p role="status" className="notice">{notice}</p>}
        <div className="button-row"><button type="submit" className="secondary" disabled={busy}>{busy ? 'Saving…' : 'Save address'}</button></div>
      </>}
  </form>;
}

function GoogleClient({ settings, onSaved }: { settings: ServerSettingsData; onSaved: () => void }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { google } = settings;
  async function update(input: ServerSettingsInput, done: string) {
    setBusy(true); setError(''); setNotice('');
    try { await save(input); setClientId(''); setClientSecret(''); setNotice(done); onSaved(); }
    catch (caught) { setError(errorMessage(caught, messages)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) { setError('Paste both the client ID and the client secret.'); return; }
    void update({ google: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } }, 'Saved. Restart Fridgedoor to start using the new Google settings.');
  }
  return <form className="settings-form" onSubmit={submit} noValidate>
    <h2>Google connection</h2>
    <p>To let people connect Gmail and Google Calendar, create an OAuth client (type “Web application”) in Google Cloud Console and paste its ID and secret here. {google.configured ? 'Google is set up.' : 'Google isn’t set up yet.'}</p>
    <label>Authorized redirect URI to add in Google Cloud<input readOnly value={google.redirectUri} spellCheck={false} onFocus={(event) => event.target.select()} /></label>
    {google.fromEnvironment
      ? <p className="muted">The Google client is set in the server’s configuration (GOOGLE_CLIENT_ID). Change it there and restart Fridgedoor.</p>
      : <>
        <label>Client ID<input autoComplete="off" spellCheck={false} value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder={google.configured ? 'Saved. Paste a new one to replace it.' : ''} maxLength={300} /></label>
        <label>Client secret<input type="password" autoComplete="off" spellCheck={false} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} maxLength={300} /></label>
        <p className="field-hint">Fridgedoor reads these when it starts, so restart the server after saving.</p>
        <FormError message={error} />
        {notice && <p role="status" className="notice">{notice}</p>}
        <div className="button-row">
          <button type="submit" className="secondary" disabled={busy}>{busy ? 'Saving…' : 'Save Google settings'}</button>
          {google.configured && <button type="button" className="secondary" disabled={busy} onClick={() => void update({ google: null }, 'Google settings deleted. Restart Fridgedoor to finish.')}>Delete Google settings</button>}
        </div>
      </>}
  </form>;
}
