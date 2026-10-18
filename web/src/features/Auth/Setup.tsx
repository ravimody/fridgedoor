import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { Member } from '@fridgedoor/contracts';
import { fetchAuthStatus, startSession } from '../../api/client.js';
import { AiEditor } from '../Settings/AiEditor.js';
import { BackgroundAi } from '../Settings/BackgroundAi.js';
import { CalendarFeed } from '../Settings/CalendarFeed.js';
import { EmailSettings } from '../Settings/EmailSettings.js';
import { InviteLink } from '../Settings/InviteLink.js';
import { PairPhone } from '../Settings/PairPhone.js';
import { AddToHomeScreen, AuthPage, emptyProfile, errorMessage, FormError, profileBody, ProfileFields, profileProblem, useFocusFirst } from './forms.js';

const STEPS = ['household', 'ai', 'email', 'calendar', 'invite', 'phone'] as const;
type Step = (typeof STEPS)[number];

/**
 * First run: create the household and owner account from the setup link, then optional steps
 * (AI, email, calendar, invite, iPhone) that can all be done later from Settings.
 */
export function SetupWizard({ member, setupRequired, onSignedIn }: { member?: Member | undefined; setupRequired?: boolean | undefined; onSignedIn: (member: Member) => void }) {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [token] = useState(() => search.get('token') ?? '');
  const [step, setStep] = useState<Step>('household');
  const [created, setCreated] = useState(false);
  const next = () => { const index = STEPS.indexOf(step); if (index === STEPS.length - 1) navigate('/', { replace: true }); else setStep(STEPS[index + 1]!); };

  // Someone already signed in who didn't just create the household has nothing to set up here.
  if (member && !created) return <Navigate to="/" replace />;
  if (!created && setupRequired === false) return <AuthPage title="This household is already set up"><p>Fridgedoor is ready to use. Sign in with your email and password.</p><p><Link className="button primary" to="/login">Sign in</Link></p></AuthPage>;
  if (!created && !token) return <AuthPage title="Open your setup link"><SetupLinkHelp /></AuthPage>;

  if (step === 'household') return <HouseholdStep token={token} onCreated={(signedIn) => {
    setCreated(true); onSignedIn(signedIn); setStep('ai');
    // The token is spent; keep it out of the address bar and history.
    navigate('/setup', { replace: true });
  }} />;
  if (step === 'ai') return <WizardStep step={step} title="Choose the planner’s AI" onNext={next} nextLabel="Skip for now">
    <AiEditor autoFocus onSaved={next} saveLabel="Save and continue" />
  </WizardStep>;
  if (step === 'email') return <EmailStep onNext={next} />;
  if (step === 'calendar') return <CalendarStep onNext={next} />;
  if (step === 'invite') return <InviteStep onNext={next} />;
  return <PhoneStep onNext={next} />;
}

/** The last step: the web app on everyone's phone; pairing only for whoever built the iPhone app. */
function PhoneStep({ onNext }: { onNext: () => void }) {
  // The public address, the same one invite links use; this browser may be on a local one.
  const [origin, setOrigin] = useState(window.location.origin);
  useEffect(() => { fetchAuthStatus().then((status) => setOrigin(status.publicUrl)).catch(() => undefined); }, []);
  return <WizardStep step="phone" title="Put Fridgedoor on your phone" onNext={onNext} nextLabel="Finish">
    <p>You and everyone you invite use Fridgedoor in the phone’s browser. Open <strong>{`${origin.replace(/\/$/, '')}/dashboard/`}</strong> on the phone, sign in, then save it like an app:</p>
    <AddToHomeScreen />
    <details className="card">
      <summary>Built the iPhone app yourself?</summary>
      <p>Until the Fridgedoor app is in the App Store, it’s installed with Xcode on a Mac, so it’s for whoever builds it. Connect it here, or later from Settings → iPhone.</p>
      <PairPhone />
    </details>
  </WizardStep>;
}

function SetupLinkHelp() {
  return <div className="card setup-help">
    <p>Setting up Fridgedoor needs the one-time setup link from your server. It looks like <code>…/dashboard/setup?token=…</code>.</p>
    <p>You’ll find it in the server’s log from when it first started. To print it again, run <code>fridgedoor setup-link</code> on the server (with Docker: <code>docker compose exec fridgedoor fridgedoor setup-link</code>). Then open that link in this browser.</p>
  </div>;
}

function WizardStep({ step, title, onNext, nextLabel, children }: { step: Step; title: string; onNext: () => void; nextLabel: string; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusFirst(content, step, heading);
  return <main className="page auth-page wizard">
    <p className="eyebrow">Step {STEPS.indexOf(step) + 1} of {STEPS.length}</p>
    <h1 ref={heading} tabIndex={-1}>{title}</h1>
    <div ref={content} className="card settings-card wizard-content">{children}</div>
    <div className="button-row wizard-nav"><button className="secondary" onClick={onNext}>{nextLabel}</button></div>
  </main>;
}

function HouseholdStep({ token, onCreated }: { token: string; onCreated: (member: Member) => void }) {
  const [householdName, setHouseholdName] = useState('');
  const [profile, setProfile] = useState(emptyProfile);
  const [error, setError] = useState<{ kind: 'message'; text: string } | { kind: 'token' | 'done' }>();
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useFocusFirst(form, 'household');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = householdName.trim() ? profileProblem(profile) : 'Give your household a name, like “The Garcias”.';
    if (problem) { setError({ kind: 'message', text: problem }); return; }
    setBusy(true); setError(undefined);
    try {
      onCreated(await startSession('/auth/setup', { token, householdName: householdName.trim(), ...profileBody(profile) }));
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : '';
      setError(code === 'SETUP_TOKEN_INVALID' ? { kind: 'token' } : code === 'SETUP_ALREADY_DONE' ? { kind: 'done' } : { kind: 'message', text: errorMessage(caught, { FORBIDDEN: 'Setup has to be finished at the server’s own address. Open the setup link exactly as it was printed and try again.' }) });
      setBusy(false);
    }
  }
  return <main className="page auth-page wizard">
    <p className="eyebrow">Step 1 of {STEPS.length}</p>
    <h1>Welcome to Fridgedoor</h1>
    <p className="muted">Let’s set up your household. This takes about two minutes. You’ll be its owner, and you can invite the people you plan with next.</p>
    <form ref={form} className="card settings-card auth-form" onSubmit={(event) => void submit(event)} noValidate>
      <label>Household name<input name="household" autoComplete="off" placeholder="The Garcias" value={householdName} onChange={(event) => setHouseholdName(event.target.value)} maxLength={80} required /></label>
      <ProfileFields value={profile} onChange={setProfile} />
      {error?.kind === 'token' && <><p role="alert" className="form-error">This setup link isn’t valid. It may have been mistyped or already used.</p><SetupLinkHelp /></>}
      {error?.kind === 'done' && <p role="alert" className="form-error">This household is already set up. <Link to="/login">Sign in instead.</Link></p>}
      <FormError message={error?.kind === 'message' ? error.text : ''} />
      <button type="submit" disabled={busy}>{busy ? 'Creating your household…' : 'Create household'}</button>
    </form>
  </main>;
}

/** Connecting reads the inbox; suggestions from it need their own consent, given right here or later in Settings → Email. */
function EmailStep({ onNext }: { onNext: () => void }) {
  const [connected, setConnected] = useState(false);
  return <WizardStep step="email" title="Connect your email" onNext={onNext} nextLabel={connected ? 'Continue' : 'Skip for now'}>
    <EmailSettings allowGoogle={false} showDeletion={false} autoFocus onConnected={() => setConnected(true)} />
    {connected && <BackgroundAi embedded />}
  </WizardStep>;
}

function InviteStep({ onNext }: { onNext: () => void }) {
  const [created, setCreated] = useState(false);
  return <WizardStep step="invite" title="Invite someone in your household" onNext={onNext} nextLabel={created ? 'Continue' : 'Skip for now'}>
    <p>Send a link to someone you plan with. They’ll make their own sign-in and see the same plans, lists and calendar. You can invite more people later from Settings → Household.</p>
    <InviteLink onCreated={() => setCreated(true)} />
  </WizardStep>;
}

function CalendarStep({ onNext }: { onNext: () => void }) {
  const [created, setCreated] = useState(false);
  return <WizardStep step="calendar" title="See your plans in your calendar" onNext={onNext} nextLabel={created ? 'Continue' : 'Skip for now'}>
    <CalendarFeed onCreated={() => setCreated(true)} />
  </WizardStep>;
}
