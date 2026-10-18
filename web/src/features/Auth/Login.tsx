import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Member } from '@fridgedoor/contracts';
import { startSession } from '../../api/client.js';
import { AuthPage, errorMessage, FormError, useFocusFirst } from './forms.js';

const NATIVE_AUTHORIZE = '/dashboard/native/authorize?';
/** Only the iPhone app's sign-in hand-off may be a `next` target; anything else goes Home. */
export function nativeNext(search: string): string | undefined {
  const next = new URLSearchParams(search).get('next');
  return next?.startsWith(NATIVE_AUTHORIZE) ? next : undefined;
}

/** /login while already signed in: continue the iPhone hand-off if that's why we're here, otherwise go Home. */
export function AlreadySignedIn() {
  const location = useLocation();
  const next = nativeNext(location.search);
  useEffect(() => { if (next) window.location.assign(next); }, [next]);
  return next ? <main className="page auth-page"><p role="status">Connecting your iPhone…</p></main> : <Navigate to="/" replace />;
}

export function LoginPage({ onSignedIn, publicUrl }: { onSignedIn: (member: Member) => void; publicUrl?: string | undefined }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useFocusFirst(form, 'login');
  const forPhone = Boolean(nativeNext(location.search));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy(true); setError('');
    try {
      const member = await startSession('/auth/login', { email: email.trim(), password });
      const next = nativeNext(location.search);
      if (next) { window.location.assign(next); return; }
      onSignedIn(member);
      navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught, { FORBIDDEN: publicUrl ? `Sign-in only works at this household’s usual address. Open ${publicUrl}/dashboard/ and try again.` : 'Sign-in only works at this household’s usual address.' }));
      setBusy(false);
    }
  }

  return <AuthPage title="Welcome back">
    <p className="muted">{forPhone ? 'Sign in to connect the Fridgedoor app on your iPhone.' : 'Sign in to see your household’s plans, lists and calendar.'}</p>
    <form ref={form} className="card settings-card auth-form" onSubmit={(event) => void submit(event)} noValidate>
      <label>Email<input name="email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      <FormError message={error} />
      <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <details className="auth-help"><summary>Forgot your password?</summary><p>Ask the person who runs your Fridgedoor server to reset it. They can run <code>fridgedoor reset-password</code> with your email and give you a temporary password to change in Settings → Account.</p></details>
  </AuthPage>;
}
