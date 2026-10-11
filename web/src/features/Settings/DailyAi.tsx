import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';

type Status = { enabled: boolean; consentVersion: string | null; revision: number; available: boolean; disclosureVersion: string };

export function DailyAi() {
  const [status, setStatus] = useState<Status>(); const [enabled, setEnabled] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => { void apiFetch<{ data: Status }>('/daily-ai-settings').then(({ data }) => { setStatus(data); setEnabled(data.enabled); }).catch(() => setNotice('Daily overview settings are unavailable until your secure session is active.')); }, []);
  async function save() {
    if (!status) return; setBusy(true); setNotice('');
    try {
      const { data } = await apiFetch<{ data: Status }>('/daily-ai-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, expectedRevision: status.revision, ...(enabled ? { consentVersion: status.disclosureVersion } : {}) }) });
      setStatus(data); setEnabled(data.enabled); setNotice(data.enabled ? 'Daily overview personalization enabled for your account.' : 'Daily overview personalization turned off.');
    } catch (error) { setNotice(error instanceof Error && error.message === 'STALE_REVISION' ? 'This setting changed elsewhere. Reload before trying again.' : 'Could not save daily overview settings.'); }
    finally { setBusy(false); }
  }
  return <section className="card settings-card"><h2>Daily planner overview</h2><p>The planner can prepare a short private overview for Home using your current plans, calendar context, reminders, recent permitted source metadata, and confirmed private facts. It does not create events, send messages, or mark tasks complete.</p><p>When enabled, this also permits scheduled maintenance suggestions. AI processing is off until you enable it here. Results are encrypted and kept for one week; usage records contain metadata only and are retained for up to 30 days.</p>{status && <><label className="checkbox"><input type="checkbox" checked={enabled} disabled={busy || (!status.available && !status.enabled)} onChange={(event) => setEnabled(event.target.checked)} /> Allow daily planner AI for my account</label><button disabled={busy || (enabled && !status.available)} onClick={() => void save()}>{enabled ? 'Enable daily planner AI' : 'Save daily planner setting'}</button>{!status.available && <p>AI is not configured on the server. The deterministic planner view remains available.</p>}</>}{notice && <p role="status">{notice}</p>}</section>;
}
