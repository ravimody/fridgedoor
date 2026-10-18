import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';

type Status = { enabled: boolean; consentVersion: string | null; revision: number; available: boolean; disclosureVersion: string };

export function DailyAi() {
  const [status, setStatus] = useState<Status>(); const [enabled, setEnabled] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => { void apiFetch<{ data: Status }>('/daily-ai-settings').then(({ data }) => { setStatus(data); setEnabled(data.enabled); }).catch(() => setNotice('Could not load your morning brief settings. Reload to try again.')); }, []);
  async function save() {
    if (!status) return; setBusy(true); setNotice('');
    try {
      const { data } = await apiFetch<{ data: Status }>('/daily-ai-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, expectedRevision: status.revision, ...(enabled ? { consentVersion: status.disclosureVersion } : {}) }) });
      setStatus(data); setEnabled(data.enabled); setNotice(data.enabled ? 'Morning brief turned on for your account.' : 'Morning brief turned off.');
    } catch (error) { setNotice(error instanceof Error && error.message === 'STALE_REVISION' ? 'This setting changed elsewhere. Reload before trying again.' : 'Could not save your morning brief setting.'); }
    finally { setBusy(false); }
  }
  return <section className="card settings-card"><h2>Morning brief</h2><p>The planner can prepare a short private morning brief for Home using your current plans, calendar context, reminders, recent permitted source metadata, and your household facts, including ones you haven’t confirmed yet. It does not create events, send messages, or mark to-dos done.</p><p>When enabled, this also permits scheduled maintenance suggestions. AI processing is off until you enable it here. Results are encrypted and kept for one week; usage records contain metadata only and are retained for up to 30 days.</p>{status && <><label className="checkbox"><input type="checkbox" checked={enabled} disabled={busy || (!status.available && !status.enabled)} onChange={(event) => setEnabled(event.target.checked)} /> Allow the AI morning brief for my account</label><button disabled={busy || (enabled && !status.available)} onClick={() => void save()}>{enabled ? 'Turn on the morning brief' : 'Save morning brief setting'}</button>{!status.available && <p>AI isn’t set up on this server yet. Without the brief, Home still shows your calendar, plans, to-dos and reminders.</p>}</>}{notice && <p role="status">{notice}</p>}</section>;
}
