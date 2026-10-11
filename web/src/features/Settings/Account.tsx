import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type HouseholdDetails, type HouseholdMember } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { useSession } from '../../app/session.js';
import { errorMessage, FormError, passwordProblem } from '../Auth/forms.js';
import { formatDay, InviteLink } from './InviteLink.js';

/** The household, its people and open invites. */
export function useHousehold() {
  const [household, setHousehold] = useState<HouseholdDetails>();
  const [loadError, setLoadError] = useState('');
  const refresh = useCallback(() => apiFetch<{ data: HouseholdDetails }>('/household').then((response) => { setHousehold(response.data); setLoadError(''); }), []);
  useEffect(() => { refresh().catch(() => setLoadError('Could not load your household. Reload to try again.')); }, [refresh]);
  return { household, loadError, refresh };
}

/** Name, email, password and sign out. */
export function AccountSection() {
  const { member } = useSession();
  const { household } = useHousehold();
  const self = household?.members.find((candidate) => candidate.id === member?.id);
  return <AccountCard name={self?.displayName ?? member?.displayName} email={self?.email} />;
}

/** The household's name, people and (for owners) invites. */
export function HouseholdSection() {
  const { member } = useSession();
  const { household, loadError, refresh } = useHousehold();
  return <section className="card settings-card">
    {loadError && <p role="alert" className="form-error">{loadError}</p>}
    {household ? <HouseholdCard household={household} selfId={member?.id} refresh={refresh} /> : !loadError && <p role="status" className="muted">Loading your household…</p>}
  </section>;
}

function AccountCard({ name, email }: { name?: string | undefined; email?: string | undefined }) {
  const { signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  return <section className="card settings-card"><h2>Profile</h2>
    <dl className="account-summary"><dt>Name</dt><dd>{name ?? '…'}</dd>{email && <><dt>Email</dt><dd>{email}</dd></>}</dl>
    {notice && <p role="status" className="notice">{notice}</p>}
    {open ? <ChangePassword onDone={(message) => { setOpen(false); setNotice(message); }} onCancel={() => setOpen(false)} />
      : <div className="button-row"><button className="secondary" onClick={() => { setNotice(''); setOpen(true); }}>Change password</button><button className="secondary" onClick={() => void signOut()}>Sign out</button></div>}
  </section>;
}

function ChangePassword({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = currentPassword ? passwordProblem(newPassword, confirm) : 'Enter your current password.';
    if (problem) { setError(problem); return; }
    setBusy(true); setError('');
    try {
      await apiFetch('/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
      onDone('Password changed. Your other devices were signed out; sign in there with the new password.');
    } catch (caught) { setError(errorMessage(caught)); setBusy(false); }
  }
  return <form className="settings-form" onSubmit={(event) => void submit(event)} noValidate>
    <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoFocus /></label>
    <label>New password<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} /></label>
    <label>Confirm new password<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} maxLength={PASSWORD_MAX_LENGTH} /></label>
    <FormError message={error} />
    <div className="button-row"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button><button type="button" className="secondary" onClick={onCancel}>Cancel</button></div>
  </form>;
}

function HouseholdCard({ household, selfId, refresh }: { household: HouseholdDetails; selfId?: string | undefined; refresh: () => Promise<void> }) {
  const [name, setName] = useState(household.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inviting, setInviting] = useState(false);
  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(done); await refresh(); }
    catch (caught) { setError(errorMessage(caught, { CANNOT_REMOVE_SELF: 'You can’t remove yourself.', NOT_FOUND: 'That was already changed. The list is up to date now.' })); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  const rename = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setError('Give your household a name.'); return; }
    void act(() => apiFetch('/household', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }), 'Household name saved.');
  };
  const setActive = (person: HouseholdMember, active: boolean) => {
    if (!active && !window.confirm(`Remove ${person.displayName}? They’ll be signed out everywhere and won’t see the household’s plans. You can restore them later.`)) return;
    void act(() => apiFetch(`/household/members/${encodeURIComponent(person.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) }), active ? `${person.displayName} can sign in again.` : `${person.displayName} was removed.`);
  };
  const revoke = (id: string) => void act(() => apiFetch(`/household/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Invite link turned off.');

  return <>
    {household.canManage
      ? <form className="settings-form inline-form" onSubmit={rename} noValidate><label>Household name<input autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} /></label><button type="submit" className="secondary" disabled={busy || name.trim() === household.name}>Rename</button></form>
      : <p><strong>{household.name}</strong></p>}
    <h2>People</h2>
    <ul className="member-list">{household.members.map((person) => <li key={person.id}>
      <span className="member-name"><strong>{person.displayName}</strong>{person.id === selfId && ' (you)'}{person.email && <small>{person.email}</small>}</span>
      <span className="member-actions">
        {person.role === 'owner' && <span className="badge">Owner</span>}
        {!person.active && <span className="badge">Removed</span>}
        {household.canManage && person.id !== selfId && (person.active
          ? <button className="secondary" disabled={busy} onClick={() => setActive(person, false)}>Remove</button>
          : <button className="secondary" disabled={busy} onClick={() => setActive(person, true)}>Restore</button>)}
      </span>
    </li>)}</ul>
    {household.canManage && <>
      {household.invites.length > 0 && <><h2>Open invite links</h2><ul className="member-list">{household.invites.map((invite) => <li key={invite.id}>
        <span className="member-name">Created {formatDay(invite.createdAt)}<small>Expires {formatDay(invite.expiresAt)}</small></span>
        <button className="secondary" disabled={busy} onClick={() => revoke(invite.id)}>Turn off link</button>
      </li>)}</ul></>}
      {inviting ? <InviteLink onCreated={() => void refresh().catch(() => undefined)} /> : <div className="button-row"><button onClick={() => setInviting(true)}>Invite someone</button></div>}
    </>}
    {!household.canManage && <p className="muted">Ask the household’s owner to invite someone new.</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <FormError message={error} />
  </>;
}
