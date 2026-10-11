import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/client.js';
type Credential = { id: string; label: string; status: string };
/** Personal tokens that let automations (Apple Shortcuts, scripts, email rules) send text to the planner. */
export function CaptureTokens() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [created, setCreated] = useState<{ id: string; token: string }>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);
  const endpoint = `${window.location.origin}/capture/v1/items`;
  useEffect(() => { void apiFetch<{ data: { credentials?: Credential[] } }>('/capture-credentials').then((result) => setCredentials(result.data.credentials ?? [])).catch(() => setNotice('Could not load your tokens. Reload to try again.')); }, []);
  async function create() {
    setBusy(true);
    try {
      const result = await apiFetch<{ data: { id: string; label: string; token: string } }>('/capture-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Automation' }) });
      setCredentials((current) => [...current, { id: result.data.id, label: result.data.label, status: 'active' }]);
      setCreated(result.data);
      setNotice('Token created. Copy it before leaving this page; it is shown only once.');
    } catch { setNotice('Could not create a token.'); }
    finally { setBusy(false); }
  }
  async function copy(value: string, token = false) {
    try { await navigator.clipboard.writeText(value); setNotice(token ? 'Token copied. Send it as “Authorization: Bearer <token>”.' : 'Address copied.'); }
    catch { if (token) { tokenInput.current?.focus(); tokenInput.current?.select(); } setNotice('Copy was blocked. Touch and hold the field to copy it manually.'); }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await apiFetch(`/capture-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setCredentials((current) => current.map((item) => item.id === id ? { ...item, status: 'revoked' } : item));
      if (created?.id === id) setCreated(undefined);
      setNotice('Token revoked. Automations using it can no longer send items.');
    } catch { setNotice('Could not revoke this token. Try again.'); }
    finally { setBusy(false); }
  }
  return <section className="card settings-card capture-tokens"><h2>Personal tokens</h2>
    <p>Create a personal token to send text to the planner from automations, such as Apple Shortcuts, a script or an email rule. Items appear on Home for review; calendar changes still need your approval.</p>
    <p>A token can only send items; it can’t read your plans or add events. Turn on the assistant in the planner’s input first. Items wait up to seven days if the assistant is off or busy.</p>
    {notice && <p role="status" className="notice">{notice}</p>}
    {created && <><label>One-time token<input ref={tokenInput} readOnly autoComplete="off" spellCheck={false} value={created.token} /></label><button onClick={() => void copy(created.token, true)}>Copy token</button></>}
    <button disabled={busy || Boolean(created)} onClick={() => void create()}>Create token</button>
    <details><summary>How to send items</summary>
      <p>First POST to <code>/capture/v1/request-id</code> with your <code>Authorization: Bearer</code> header. Use the returned <code>data.clientCaptureId</code> as both the <code>Idempotency-Key</code> header and the JSON <code>clientCaptureId</code> when posting text to the address below. Keep that ID when retrying the same request; a new ID creates a new item.</p>
      <label>Capture address<input readOnly value={endpoint} /></label><button className="secondary" onClick={() => void copy(endpoint)}>Copy address</button>
      <p>Each person should create their own token. Don’t share an automation that has your token in it.</p>
    </details>
    {credentials.filter((item) => item.status === 'active').map((item) => <p key={item.id}>{item.label} <button className="secondary" disabled={busy} onClick={() => void revoke(item.id)}>Revoke token</button></p>)}
  </section>;
}
