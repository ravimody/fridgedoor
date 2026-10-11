import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { inviteInfoSchema, type InviteInfo, type Member } from '@fridgedoor/contracts';
import { publicFetch, startSession } from '../../api/client.js';
import { AuthPage, emptyProfile, errorMessage, FormError, profileBody, ProfileFields, profileProblem, useFocusFirst } from './forms.js';

type InviteState = { status: 'loading' } | { status: 'invalid' } | { status: 'error' } | { status: 'open'; info: InviteInfo };

export function JoinPage({ member, onSignedIn, onSignOut }: { member?: Member | undefined; onSignedIn: (member: Member) => void; onSignOut: () => Promise<void> }) {
  const { token = '' } = useParams();
  const [invite, setInvite] = useState<InviteState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    publicFetch(`/auth/invites/${encodeURIComponent(token)}`)
      .then((body) => { if (active) setInvite({ status: 'open', info: inviteInfoSchema.parse(body).data }); })
      .catch((error: unknown) => { if (active) setInvite({ status: error instanceof Error && error.message === 'INVITE_INVALID' ? 'invalid' : 'error' }); });
    return () => { active = false; };
  }, [token]);

  if (member) return <AuthPage title="You’re already signed in">
    <p>You’re signed in as <strong>{member.displayName}</strong>. This invite is for someone new: open the link on their phone or computer, or sign out first to join with a different account.</p>
    <div className="button-row"><Link className="button primary" to="/">Go to Home</Link><button className="secondary" onClick={() => void onSignOut()}>Sign out</button></div>
  </AuthPage>;
  if (invite.status === 'loading') return <main className="page auth-page"><p role="status">Opening your invite…</p></main>;
  if (invite.status === 'invalid') return <InvalidInvite />;
  if (invite.status === 'error') return <AuthPage title="Couldn’t open this invite"><p role="alert">Fridgedoor didn’t respond. Check your connection and reload the page.</p></AuthPage>;
  return <JoinForm token={token} info={invite.info} onSignedIn={onSignedIn} onInvalid={() => setInvite({ status: 'invalid' })} />;
}

function InvalidInvite() {
  return <AuthPage title="This invite has expired">
    <p>Invite links work for one person and expire after 7 days. Ask the person who invited you to send a new link.</p>
    <p><Link to="/login">Already have an account? Sign in</Link></p>
  </AuthPage>;
}

function JoinForm({ token, info, onSignedIn, onInvalid }: { token: string; info: InviteInfo; onSignedIn: (member: Member) => void; onInvalid: () => void }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(emptyProfile);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useFocusFirst(form, 'join');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = profileProblem(profile);
    if (problem) { setError(problem); return; }
    setBusy(true); setError('');
    try {
      onSignedIn(await startSession(`/auth/invites/${encodeURIComponent(token)}`, profileBody(profile)));
      navigate('/', { replace: true });
    } catch (caught) {
      if (caught instanceof Error && caught.message === 'INVITE_INVALID') { onInvalid(); return; }
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  return <AuthPage eyebrow="You’re invited" title={`Join ${info.householdName}`}>
    <p className="muted">{info.invitedBy} invited you to share plans, lists and the family calendar on Fridgedoor. Make your own sign-in below.</p>
    <form ref={form} className="card settings-card auth-form" onSubmit={(event) => void submit(event)} noValidate>
      <ProfileFields value={profile} onChange={setProfile} />
      <FormError message={error} />
      <button type="submit" disabled={busy}>{busy ? 'Joining…' : `Join ${info.householdName}`}</button>
    </form>
    <p className="muted">Already have an account? <Link to="/login">Sign in</Link></p>
  </AuthPage>;
}
