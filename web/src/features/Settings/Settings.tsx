import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { AiAdminSettings, CalendarFeedStatus, EmailConnection, HouseholdDetails, ServerSettings as ServerSettingsData } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { AppearancePicker } from '../../app/appearance.js';
import { useSession } from '../../app/session.js';
import { AccountSection, HouseholdSection, useHousehold } from './Account.js';
import { AiEditor } from './AiEditor.js';
import { BackgroundAi } from './BackgroundAi.js';
import { CalendarFeed } from './CalendarFeed.js';
import { CalendarSettings } from './CalendarSettings.js';
import { CaptureTokens } from './CaptureTokens.js';
import { DailyAi } from './DailyAi.js';
import { EmailPrivacy, PrivacyDisclosure } from './EmailPrivacy.js';
import { EmailSettings } from './EmailSettings.js';
import { MorningDigest } from './MorningDigest.js';
import { Notifications } from './Notifications.js';
import { PairPhone } from './PairPhone.js';
import { ServerSettings } from './ServerSettings.js';

/** `/settings/*`: a short index of pages, each a focused page with a way back. */
export function Settings() {
  return <Routes>
    <Route index element={<SettingsIndex />} />
    <Route path="account" element={<AccountPage />} />
    <Route path="household" element={<SettingsPage title="Household"><HouseholdSection /></SettingsPage>} />
    <Route path="email" element={<EmailPage />} />
    <Route path="calendar" element={<CalendarPage />} />
    <Route path="ai" element={<OwnerPage title="AI"><section className="card settings-card"><AiEditor allowRemove /></section></OwnerPage>} />
    <Route path="notifications" element={<SettingsPage title="Notifications"><MorningDigest /><Notifications /><DailyAi /></SettingsPage>} />
    <Route path="iphone" element={<SettingsPage title="iPhone"><section className="card settings-card"><PairPhone /></section></SettingsPage>} />
    <Route path="other-apps" element={<SettingsPage title="Send from other apps"><CaptureTokens /></SettingsPage>} />
    <Route path="server" element={<OwnerPage title="Server"><ServerSettings /></OwnerPage>} />
    <Route path="*" element={<Navigate to="/settings" replace />} />
  </Routes>;
}

type Overview = { household?: HouseholdDetails | undefined; connection?: EmailConnection | undefined; feed?: CalendarFeedStatus | undefined; ai?: AiAdminSettings | undefined; server?: ServerSettingsData | undefined };
const load = <T,>(path: string) => apiFetch<{ data: T }>(path).then((response) => response.data, () => undefined);

function SettingsIndex() {
  const { search } = useLocation();
  const { member } = useSession();
  const [overview, setOverview] = useState<Overview>({});
  const oauth = new URLSearchParams(search).get('oauth');
  useEffect(() => {
    if (oauth) return;
    let active = true;
    const merge = (next: Overview) => { if (active) setOverview((current) => ({ ...current, ...next })); };
    void load<HouseholdDetails>('/household').then((household) => {
      merge({ household });
      if (household?.canManage) void Promise.all([load<AiAdminSettings>('/admin/ai'), load<ServerSettingsData>('/admin/server')]).then(([ai, server]) => merge({ ai, server }));
    });
    void load<EmailConnection>('/connection').then((connection) => merge({ connection }));
    void load<CalendarFeedStatus>('/calendar-feed').then((feed) => merge({ feed }));
    return () => { active = false; };
  }, [oauth]);
  // Google's OAuth callback lands on /settings?oauth=…: show the result where the next step is.
  if (oauth) return <Navigate replace to={`/settings/${oauth === 'success' ? 'calendar' : 'email'}?oauth=${encodeURIComponent(oauth)}`} />;

  const { household, connection, feed, ai, server } = overview;
  const self = household?.members.find((candidate) => candidate.id === member?.id);
  const people = household?.members.filter((person) => person.active).length;
  const owner = household?.canManage;
  return <main className="page settings-index">
    <p className="eyebrow">Fridgedoor</p>
    <h1>Settings</h1>
    <SettingsGroup title="You">
      <SettingsLink to="account" title="Account" summary={join(self?.displayName ?? member?.displayName, self?.email)} />
      <SettingsLink to="notifications" title="Notifications" summary="Phone alerts, morning digest, daily overview" />
    </SettingsGroup>
    <SettingsGroup title="Household">
      <SettingsLink to="household" title="Household" summary={household && join(household.name, `${people} ${people === 1 ? 'person' : 'people'}`)} />
      {owner && <SettingsLink to="ai" title="AI" summary={ai && aiSummary(ai)} />}
      {owner && <SettingsLink to="server" title="Server" summary={server && join(hostOf(server.publicUrl), server.google.configured ? 'Google set up' : 'Google not set up')} />}
    </SettingsGroup>
    <SettingsGroup title="Email & calendar">
      <SettingsLink to="email" title="Email" summary={connection && emailSummary(connection)} />
      <SettingsLink to="calendar" title="Calendar" summary={feed && join(feed.active ? 'Calendar link on' : 'No calendar link', connection?.provider === 'google' && connection.status === 'active' ? 'Google calendars' : undefined)} />
    </SettingsGroup>
    <SettingsGroup title="Apps & devices">
      <SettingsLink to="iphone" title="iPhone" summary="Sign in the Fridgedoor app with a code" />
      <SettingsLink to="other-apps" title="Send from other apps" summary="Tokens for Shortcuts, scripts and email rules" />
    </SettingsGroup>
  </main>;
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h2>{title}</h2><ul className="settings-links">{children}</ul></section>;
}
function SettingsLink({ to, title, summary }: { to: string; title: string; summary?: string | undefined }) {
  return <li><Link to={`/settings/${to}`}><span><strong>{title}</strong>{summary && <small>{summary}</small>}</span></Link></li>;
}

const join = (...parts: (string | undefined | null)[]) => parts.filter(Boolean).join(' · ') || undefined;
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
/** "5 min ago" for recent times, then the date. */
function ago(iso: string, now = Date.now()) {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} hr ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function emailSummary(connection: EmailConnection) {
  if (!connection.connected || connection.status === 'disconnected') return 'Not connected';
  const state = connection.status === 'needs_reauth' ? 'needs attention' : connection.status === 'paused' ? 'paused' : connection.syncLastSuccessAt ? `checked ${ago(connection.syncLastSuccessAt)}` : 'not checked yet';
  return join(connection.email, state);
}
function aiSummary({ current, presets }: AiAdminSettings) {
  if (!current) return 'Not set up';
  return join(presets.find((preset) => preset.id === current.provider)?.label ?? current.provider, current.models.main);
}

/** A focused settings page: a way back to the index, the page's name and its cards. */
function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  return <main className="page settings-page">
    <Link className="settings-back" to="/settings"><span aria-hidden="true">‹ </span>Settings</Link>
    <h1>{title}</h1>
    {children}
  </main>;
}

/** Pages only the household's owners can use; the server refuses everyone else anyway. */
function OwnerPage({ title, children }: { title: string; children: ReactNode }) {
  const { household, loadError } = useHousehold();
  return <SettingsPage title={title}>
    {loadError ? <p role="alert" className="form-error">{loadError}</p>
      : !household ? <p role="status" className="muted">Loading…</p>
      : household.canManage ? children
      : <p className="notice">Only the household’s owner can change these settings.</p>}
  </SettingsPage>;
}

function AccountPage() {
  return <SettingsPage title="Account">
    <AccountSection />
    <section className="card settings-card"><h2>Appearance</h2><AppearancePicker /><p className="muted">Applies on this device. System follows your device’s light or dark setting.</p></section>
  </SettingsPage>;
}

const oauthMessages: Record<string, string> = {
  success: 'Google connected. Choose calendars below to begin sync.',
  google_account_mismatch: 'Google returned a different account than this planner member.',
  google_scopes_insufficient: 'Google did not grant all requested permissions. Try connecting again and approve the listed access.',
};
/** The result of the Google consent round trip, from `?oauth=`. */
function useOauthNotice() {
  const result = new URLSearchParams(useLocation().search).get('oauth');
  return result ? oauthMessages[result] ?? 'Google connection did not complete. Try connecting again.' : '';
}

function EmailPage() {
  const notice = useOauthNotice();
  return <SettingsPage title="Email">
    {notice && <p role="status" className="notice">{notice}</p>}
    <section className="card settings-card"><h2>Mailbox</h2><EmailSettings /></section>
    <BackgroundAi />
    <EmailPrivacy />
    <PrivacyDisclosure />
  </SettingsPage>;
}

function CalendarPage() {
  const notice = useOauthNotice();
  const [connection, setConnection] = useState<EmailConnection>();
  useEffect(() => { void load<EmailConnection>('/connection').then(setConnection); }, []);
  return <SettingsPage title="Calendar">
    {notice && <p role="status" className="notice">{notice}</p>}
    <section className="card settings-card"><h2>See your plans in your calendar app</h2><CalendarFeed /></section>
    {connection && connection.provider !== 'imap' && <CalendarSettings status={connection.status} revision={connection.revision} onRevisionChange={(revision) => setConnection((current) => current && { ...current, revision })} />}
  </SettingsPage>;
}
