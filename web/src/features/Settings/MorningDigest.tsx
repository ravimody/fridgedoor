import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';
type Status = { enabled: boolean; localTime: string; timezone: string; revision: number; available: boolean; devices: number; lastDelivery: { date: string; accepted: number; pending: number } | null };
export function MorningDigest() {
  const [status, setStatus] = useState<Status>(); const [enabled, setEnabled] = useState(false); const [time, setTime] = useState('07:00'); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => { void apiFetch<{ data: Status }>('/morning-digest').then(({ data }) => { setStatus(data); setEnabled(data.enabled); setTime(data.localTime); }).catch(() => setNotice('Could not load morning settings. Reload to try again.')); }, []);
  async function save() {
    if (!status) return; setBusy(true); setNotice('');
    try {
      const { data } = await apiFetch<{ data: Status }>('/morning-digest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, localTime: time, expectedRevision: status.revision }) });
      setStatus(data); setNotice(data.enabled ? 'Morning notification saved for your account.' : 'Morning notification turned off.');
    } catch { setNotice('Could not save. Reload to check the current setting before trying again.'); }
    finally { setBusy(false); }
  }
  return <section className="card settings-card"><h2>Morning notification</h2><p>A daily notification opens Home: your morning brief if it’s on, plus current plans, to-dos and pending decisions. Details stay inside the app. Google and AI access are optional.</p>
    {status && <><label className="checkbox"><input type="checkbox" checked={enabled} disabled={busy || (!status.available && !status.enabled)} onChange={(event) => setEnabled(event.target.checked)} /> Send me a morning notification</label>
      <label>Morning time<input type="time" value={time} disabled={busy} onChange={(event) => setTime(event.target.value)} /></label><p>Time zone: {status.timezone}</p>
      <button disabled={busy || !time || (enabled && !status.available)} onClick={() => void save()}>Save morning settings</button>
      {!status.available ? <p>Phone delivery is not configured on the server.</p> : status.devices === 0 && <p>Enable notifications on this phone below to receive the morning notification.</p>}
      <p>If the server is briefly offline, delivery can arrive up to four hours late. Turning off stops future attempts. Time changes after today’s delivery was prepared take effect tomorrow. Email delivery is not available yet.</p>
      {status.lastDelivery && <p>Last attempted day: {status.lastDelivery.date}. {status.lastDelivery.accepted} device deliveries accepted by the push service; this does not confirm receipt on the phone.</p>}
    </>}{notice && <p role="status">{notice}</p>}
  </section>;
}
