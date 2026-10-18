import { useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { Link } from 'react-router-dom';
import type { PlanFacts } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
export function ReminderEditor({ parentType, parentId, time }: { parentType: 'plan' | 'list_item'; parentId: string; time?: PlanFacts['time'] }) {
  const anchor = time?.kind === 'deadline' ? time.at : time?.kind === 'timed' ? time.start : undefined;
  const zone = time?.kind === 'timed' || time?.kind === 'deadline' ? time.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [mode, setMode] = useState('time'); const [due, setDue] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const submission = useRef<{ body: string; key: string } | undefined>(undefined);
  async function save() {
    const offset = mode === 'time' ? undefined : Number(mode);
    const at = offset !== undefined && anchor ? DateTime.fromISO(anchor).plus({ minutes: offset }) : DateTime.fromISO(due, { zone });
    if (!at.isValid || at <= DateTime.now()) { setNotice('Choose a future reminder time.'); return; }
    setBusy(true); setNotice('');
    try {
      const body = JSON.stringify({ parentType, parentId, dueAt: at.toUTC().toISO(), timezone: zone, ...(offset === undefined ? {} : { offsetMinutes: offset }) });
      if (submission.current?.body !== body) submission.current = { body, key: crypto.randomUUID() };
      await apiFetch('/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.current.key }, body });
      setNotice('Reminder saved for you. Manage it on Home. Phone delivery requires notifications enabled in Settings → Notifications.');
    } catch { setNotice('Could not save the reminder. Check the item and try again.'); }
    finally { setBusy(false); }
  }
  return <details className="reminder-editor"><summary>Remind me</summary><div className="capture-card">{anchor && <label>When<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="time">Choose a time</option><option value="-15">15 minutes before</option><option value="-60">1 hour before</option><option value="-1440">1 day before</option></select></label>}{mode === 'time' && <label>Reminder time<input type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} /></label>}<p className="muted">{zone} · Just for you. Google’s own alerts are separate.</p><button disabled={busy} onClick={() => void save()}>Save reminder</button><Link to="/settings/notifications">Notification settings</Link>{notice && <p role="status">{notice}</p>}</div></details>;
}
