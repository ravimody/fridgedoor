import { useRef, useState } from 'react';
import type { CreatedInvite } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { errorMessage, FormError } from '../Auth/forms.js';

export const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

/** Creates a one-time invite link and offers Copy and (where the device supports it) Share. */
export function InviteLink({ onCreated }: { onCreated?: (invite: CreatedInvite) => void }) {
  const [invite, setInvite] = useState<CreatedInvite>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const canShare = typeof navigator.share === 'function';

  async function create() {
    setBusy(true); setError(''); setNotice('');
    try {
      const created = (await apiFetch<{ data: CreatedInvite }>('/household/invites', { method: 'POST' })).data;
      setInvite(created); onCreated?.(created);
    } catch (caught) { setError(errorMessage(caught, { FORBIDDEN: 'Only the household’s owner can invite people.' })); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!invite) return;
    try { await navigator.clipboard.writeText(invite.url); setNotice('Link copied. Paste it into a message to the person you’re inviting.'); }
    catch { field.current?.focus(); field.current?.select(); setNotice('Copying was blocked. Touch and hold the link to copy it.'); }
  }
  async function share() {
    if (!invite) return;
    try { await navigator.share({ title: 'Join our household on Fridgedoor', text: 'Here’s your invite to our household planner on Fridgedoor.', url: invite.url }); }
    catch (caught) { if (!(caught instanceof DOMException && caught.name === 'AbortError')) setNotice('Sharing didn’t work. Copy the link instead.'); }
  }

  if (!invite) return <div className="invite-link"><FormError message={error} /><div className="button-row"><button disabled={busy} onClick={() => void create()}>{busy ? 'Creating link…' : 'Create invite link'}</button></div></div>;
  return <div className="invite-link">
    <label>Invite link<input ref={field} readOnly value={invite.url} spellCheck={false} onFocus={(event) => event.target.select()} /></label>
    <div className="button-row">
      <button onClick={() => void copy()}>Copy link</button>
      {canShare && <button className="secondary" onClick={() => void share()}>Share…</button>}
    </div>
    <p className="field-hint">This link is shown only once. It works for one person and expires on {formatDay(invite.expiresAt)}.</p>
    {notice && <p role="status" className="notice">{notice}</p>}
    <FormError message={error} />
    <button className="secondary" disabled={busy} onClick={() => void create()}>Create another link</button>
  </div>;
}
