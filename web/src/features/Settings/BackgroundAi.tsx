import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';
/** `providerLabel` is the AI preset's display name, when the server sends it. */
type Status = { provider: string | null; providerLabel?: string | null; model: string | null; failuresLastDay: number; available: boolean; enabled: boolean; revision: number; connectionActive: boolean; attemptsLastDay: number; attemptsLastHour: number; volumeWarning: boolean; pausedForVolume: boolean; dailyLimit: number; hourlyLimit: number; pending: number; lastProcessedAt: string | null };
/** The per-person switch for AI suggestions from email. `embedded` drops the card and the volume details, for the setup wizard. */
export function BackgroundAi({ embedded = false }: { embedded?: boolean }) {
  const [status, setStatus] = useState<Status>();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => { void apiFetch<{ data: Status }>('/background-ai').then((response) => setStatus(response.data)).catch(() => setNotice('Could not load email suggestion settings. Reload to try again.')); }, []);
  async function save() {
    if (!status) return;
    setBusy(true); setNotice('');
    try {
      const response = await apiFetch<{ data: Status }>('/background-ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !status.enabled, expectedRevision: status.revision }) });
      setStatus(response.data); setAccepted(false);
      setNotice(response.data.enabled ? 'Email suggestions enabled for your account.' : 'Email suggestions turned off. Your email stays connected until you disconnect it.');
    } catch { setNotice('Could not save. Reload to check the current setting before trying again.'); }
    finally { setBusy(false); }
  }
  return <section className={embedded ? 'background-ai' : 'card settings-card'}><h2>Email suggestions</h2>
    {notice && <p role="status">{notice}</p>}
    {status && <><p>{status.enabled ? 'On for your account.' : status.connectionActive ? 'Off for your account. Fridgedoor checks your inbox but won’t suggest plans from it until you turn this on.' : 'Off for your account.'} {!status.available ? 'AI isn’t set up on this server yet, so suggestions can’t start.' : !status.connectionActive ? 'Connect or resume your email to get suggestions.' : ''}</p>
      {status.provider && <p>AI provider: {status.providerLabel ?? status.provider}. Model: {status.model ?? 'Not configured'}.</p>}
      <p>The configured AI provider receives limited email text and supported attachments to suggest household plans. Permitted logistics may be shared with your household; source emails stay private. Calendar changes require approval. {embedded ? 'Settings → Email has the full provider and retention details.' : 'Review the provider and retention details below.'}</p>
      <p>Enabling starts with up to 100 recent retained emails, then new email as it arrives. Excluded senders and labels are skipped before AI when recognized; this cannot guarantee every work message is excluded. Turning this off stops future analysis, including pending results, but does not remove saved suggestions or disconnect your email.</p>
      {!status.enabled && <label className="checkbox"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I agree to background AI processing and the sharing and retention described here.</label>}
      <button disabled={busy || (!status.enabled && (!accepted || !status.available))} onClick={() => void save()}>{status.enabled ? 'Disable email suggestions' : 'Enable email suggestions'}</button>
      {!embedded && <>
      <p>{status.attemptsLastDay} email analyses attempted in the last 24 hours. {status.pending} queued.</p>
      {status.volumeWarning && <p role="status">Unusually high email processing: {status.attemptsLastHour} attempts in the last hour and {status.attemptsLastDay} in the last 24 hours. This can happen during catch-up or an email flood. {status.pausedForVolume ? 'Analysis is temporarily paused and resumes automatically as volume falls. Queued emails are retained subject to normal source expiry.' : 'Analysis continues. You can disable email suggestions above if this is unexpected.'}</p>}
      <p>Emergency protection pauses analysis at {status.hourlyLimit} attempts per hour or {status.dailyLimit} per day. These are volume safeguards, not spending caps.</p>
      {status.failuresLastDay > 0 && <p role="status">{status.failuresLastDay} analyses failed in the last 24 hours. These emails may not have produced suggestions.</p>}
      <p>{status.lastProcessedAt ? `Last successful analysis: ${new Date(status.lastProcessedAt).toLocaleString()}.` : 'No successful email analysis yet.'}</p>
      </>}
    </>}
  </section>;
}
