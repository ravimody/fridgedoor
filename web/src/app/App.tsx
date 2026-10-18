import {AppearancePicker} from './appearance.js';
import { RelevanceTrial } from '../features/Feedback/RelevanceTrial.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { AuthStatus, Member } from '@fridgedoor/contracts';
import { bootstrap, fetchAuthStatus, logout } from '../api/client.js';
import { AuthPage } from '../features/Auth/forms.js';
import { AlreadySignedIn, LoginPage } from '../features/Auth/Login.js';
import { JoinPage } from '../features/Auth/Join.js';
import { SetupWizard } from '../features/Auth/Setup.js';
import { SessionContext } from './session.js';
import { Settings } from '../features/Settings/Settings.js';
import { Home, RequestDetail, PlannerArchive } from '../features/Home/Home.js';
import { Household } from '../features/Home/Household.js';
import { PlannerProvider, usePlanner } from '../features/Home/PlannerContext.js';
import { Composer } from '../features/Home/Composer.js';
import { Lists } from '../features/Lists/Lists.js';
import { PlanDetail } from '../features/Plans/PlanDetail.js';

type Status = 'loading' | 'ready' | 'unavailable';
export function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [member, setMember] = useState<Member>();
  const [auth, setAuth] = useState<AuthStatus>();
  const [attempt, setAttempt] = useState(0);
  // Signed in already? Otherwise ask the server whether this is a first run (setup) or a normal sign-in.
  useEffect(() => {
    let active = true;
    bootstrap().then((next) => { if (active) { setMember(next); setStatus('ready'); } })
      .catch(() => fetchAuthStatus().then((next) => { if (active) { setAuth(next); setStatus('ready'); } }))
      .catch(() => { if (active) setStatus('unavailable'); });
    return () => { active = false; };
  }, [attempt]);
  const signedIn = useCallback((next: Member) => setMember(next), []);
  const signOut = useCallback(async () => {
    await logout().catch(() => undefined);
    setMember(undefined);
    setAuth((current) => current && { ...current, setupRequired: false });
  }, []);
  // The server stopped accepting this session: check again, which lands on sign-in (or setup, or the identity proxy).
  const expired = useCallback(() => { setMember(undefined); setStatus('loading'); setAttempt((count) => count + 1); }, []);
  const session = useMemo(() => ({ member, signOut }), [member, signOut]);
  if (status === 'loading') return <main className="page"><p role="status">Opening Fridgedoor…</p></main>;
  if (status === 'unavailable') return <AuthPage title="Can’t reach Fridgedoor"><p role="alert">The server didn’t respond. Check your connection, or ask whoever runs your Fridgedoor server whether it’s up.</p><button onClick={() => { setStatus('loading'); setAttempt((count) => count + 1); }}>Try again</button></AuthPage>;
  const signedOut = auth?.setupRequired ? <Navigate to="/setup" replace /> : auth?.accessMode ? <OutsideSignIn /> : <Navigate to="/login" replace />;
  return <SessionContext.Provider value={session}><Routes>
    <Route path="/setup" element={<SetupWizard member={member} setupRequired={auth?.setupRequired} onSignedIn={signedIn} />} />
    <Route path="/join/:token" element={<JoinPage member={member} onSignedIn={signedIn} onSignOut={signOut} />} />
    <Route path="/login" element={member ? <AlreadySignedIn /> : auth?.setupRequired || auth?.accessMode ? signedOut : <LoginPage onSignedIn={signedIn} publicUrl={auth?.publicUrl} />} />
    <Route path="*" element={member ? <Shell member={member} signOut={signOut} onExpired={expired} /> : signedOut} />
  </Routes></SessionContext.Provider>;
}

function Shell({ member, signOut, onExpired }: { member: Member; signOut: () => Promise<void>; onExpired: () => void }) {
  return <PlannerProvider timezone={member.timezone} onExpired={onExpired}><div className="shell"><header><Link className="brand" to="/">Fridgedoor</Link><ProfileMenu member={member} signOut={signOut} /></header><nav className="primary-nav" aria-label="Primary"><NavLink end to="/"><NavIcon kind="home"/>Home</NavLink><NavLink to="/todos"><NavIcon kind="todo"/>To do</NavLink><NavLink to="/groceries"><NavIcon kind="grocery"/>Groceries</NavLink><NavLink to="/more"><NavIcon kind="more"/>More</NavLink></nav><PlannerNotice /><Routes><Route path="/requests/feedback-trial" element={<Navigate to="/relevance-trial" replace />} /><Route path="/relevance-trial" element={<RelevanceTrial />} /><Route path="/settings/*" element={<Settings />} /><Route path="/requests/:id" element={<RequestDetail />} /><Route path="/plans/:id" element={<PlanDetail />} /><Route path="/lists" element={<Lists />} /><Route path="/todos" element={<Lists initialKind="todo" key="todo" />} /><Route path="/groceries" element={<Lists initialKind="grocery" key="grocery" />} /><Route path="/more" element={<More />} /><Route path="/suggestions" element={<PlannerArchive />} /><Route path="/history" element={<PlannerArchive history />} /><Route path="/household" element={<Household />} /><Route path="/" element={<Home />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes><Composer /></div></PlannerProvider>;
}

/** When an identity proxy sits in front of the server, signing in happens there rather than on our sign-in page. */
function OutsideSignIn() {
  return <AuthPage title="Sign in to see your household’s plans"><p>This server checks who you are before Fridgedoor opens. Sign in there, then try again. If you’re signed in and still see this, ask the household’s owner to add you.</p><button onClick={() => window.location.assign('/dashboard/')}>Try again</button></AuthPage>;
}
/** A disclosure menu that closes on a choice, a route change, a click outside it, or Escape. */
function ProfileMenu({ member, signOut }: { member: Member; signOut: () => Promise<void> }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const { pathname } = useLocation();
  const close = useCallback(() => { if (menu.current) menu.current.open = false; }, []);
  useEffect(() => { close(); }, [pathname, close]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (menu.current?.open && !menu.current.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current?.open) { close(); menu.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [close]);
  return <details ref={menu} className="profile-menu"><summary>{member.displayName}</summary><Link to="/settings" onClick={close}>Settings</Link><button className="logout" onClick={() => { close(); void signOut(); }}>Sign out</button></details>;
}
function NavIcon({kind}:{kind:'home'|'todo'|'grocery'|'more'}){return <svg viewBox="0 0 24 24" aria-hidden="true">{kind==='home'?<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3Z"/>:kind==='todo'?<path d="m3 6 2 2 3-4m3 2h10M3 13h4m4 0h10M3 20h4m4 0h10"/>:kind==='grocery'?<path d="M4 8h16l-2 13H6Zm4 0 4-6 4 6"/>:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>}</svg>;}
function More(){return <main className="page"><p className="eyebrow">Your planner</p><h1>More</h1><section className="card more-links"><Link to="/suggestions">Saved plans & suggestions</Link><Link to="/history">Requests</Link><Link to="/household">Household facts</Link><Link to="/relevance-trial">Teach suggestions</Link><Link to="/settings">Settings</Link><AppearancePicker /></section></main>;}
function PlannerNotice() { const planner = usePlanner(); return planner.notice && !planner.composerOpen ? <p role="status" className="notice page">{planner.notice}</p> : null; }
