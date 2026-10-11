import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client.js';

type Calendar = { id: string; name: string; selected: boolean; classification: 'household'|'personal'|'work'; accessRole: string; isDestination?: boolean; sync?: { lastSuccessAt: string | null; error: string | null; stale: boolean; imported: number; upcoming: number } };
type Destination = { id: string; name: string; active: boolean; ownCalendarSelectionId: string | null } | null;
const canWrite = (calendar: Calendar) => calendar.selected && ['writer', 'owner'].includes(calendar.accessRole) && calendar.classification !== 'work';

export function CalendarSettings({ status, revision, onRevisionChange }: { status: string | undefined; revision: number | undefined; onRevisionChange: (revision: number) => void }) {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [destination, setDestination] = useState<Destination>(null);
  const [choice, setChoice] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    if (status === 'active') void Promise.all([
      apiFetch<{ data: Calendar[] }>('/source-calendars'),
      apiFetch<{ data: Destination }>('/destination'),
    ]).then(([sources, target]) => {
      if (!active) return;
      setCalendars(sources.data);
      setDestination(target.data);
      setChoice(target.data?.ownCalendarSelectionId ?? '');
      setLoaded(true);
    }).catch(() => { if (active) setNotice('Could not load calendar settings. Reload this page to try again.'); });
    return () => { active = false; };
  }, [status]);

  async function refreshStatus() {
    try {
      const result = await apiFetch<{ data: Calendar[] }>('/source-calendars');
      setCalendars((current) => current.map((calendar) => {
        const fresh = result.data.find((item) => item.id === calendar.id);
        return fresh ? { ...calendar, ...(fresh.sync ? { sync: fresh.sync } : {}), isDestination: Boolean(fresh.isDestination) } : calendar;
      }));
      setNotice('Sync status refreshed. Unsaved choices are unchanged.');
    } catch { setNotice('Could not refresh sync status. Try again shortly.'); }
  }
  const writable = calendars.filter(canWrite);
  const selectedChoice = writable.some((calendar) => calendar.id === choice) ? choice : '';
  async function save() {
    if (saving || !loaded) return;
    setSaving(true);
    setNotice('');
    let sourcesSaved = false;
    try {
      const result = await apiFetch<{ data: Calendar[] }>('/source-calendars', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections: calendars.map(({ id, selected, classification }) => ({ id, selected, classification })) }) });
      sourcesSaved = true;
      setCalendars(result.data);
      if (selectedChoice && selectedChoice !== destination?.ownCalendarSelectionId) {
        if (revision === undefined) throw new Error('STALE_REVISION');
        const target = await apiFetch<{ data: Destination }>('/destination', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownCalendarSelectionId: selectedChoice, expectedRevision: revision }) });
        setDestination(target.data);
        onRevisionChange(revision + 1);
      }
      setNotice(selectedChoice ? 'Calendar choices saved.' : 'Calendar sources saved. Choose a writable destination to add plans to Google Calendar.');
    } catch {
      setNotice(sourcesSaved ? 'Sources saved, but the destination could not be saved. Reload this page and try again.' : 'Calendar choices could not be saved. Reload this page and try again.');
    } finally { setSaving(false); }
  }

  if (status !== 'active') return null;
  return <section className="card settings-card"><h2>Calendars to read</h2><p>Select each calendar you want on Home. Selecting a calendar here reads its events; it does not choose where new events are added. Sync runs about every five minutes.</p><p className="muted">Household events are shared. Personal and work calendars are visible only to you, unless that calendar is the household destination.</p>
    {notice && <p role="status" className="notice">{notice}</p>}
    {!loaded ? <p>Loading calendars…</p> : calendars.length ? <div className="calendar-list">{calendars.map((calendar) => <div className="calendar-row" key={calendar.id}>
      <label className="calendar-check"><input type="checkbox" disabled={saving} checked={calendar.selected} onChange={(event) => setCalendars((current) => current.map((item) => item.id === calendar.id ? { ...item, selected: event.target.checked } : item))} /><span><strong>{calendar.name}</strong><small>{calendar.accessRole}</small></span></label>
      <select aria-label={`${calendar.name} privacy`} disabled={saving} value={calendar.classification} onChange={(event) => setCalendars((current) => current.map((item) => item.id === calendar.id ? { ...item, classification: event.target.value as Calendar['classification'] } : item))}><option value="household">Household · shared</option><option value="personal">Personal · only you</option><option value="work">Work · only you</option></select>
      <div className="calendar-sync-status">{calendar.selected || calendar.isDestination ? <>
        {calendar.isDestination && <p>Also read as the shared destination.</p>}
        <p>{calendar.sync?.lastSuccessAt ? `Last synced ${new Date(calendar.sync.lastSuccessAt).toLocaleString()}` : 'Waiting for first successful sync.'}</p>
        <p>{calendar.sync?.imported ?? 0} imported events · {calendar.sync?.upcoming ?? 0} in the next seven days</p>
        {calendar.sync?.error && <p role="status">{calendar.sync.error === 'reconnect' ? 'Reconnect Google to resume syncing.' : calendar.sync.error === 'resyncing' ? 'Refreshing calendar history. The worker will retry automatically.' : 'Calendar sync failed. Retrying automatically; existing events may be out of date.'}</p>}
        {calendar.sync?.stale && !calendar.sync.error && <p role="status">Sync is overdue. Events may be out of date.</p>}
        {calendar.sync?.lastSuccessAt && !calendar.sync.upcoming && <p className="muted">No imported events from this calendar fall in the week view. Check that you selected the calendar containing your upcoming plans.</p>}
      </> : <p>Not selected for reading.</p>}</div>
    </div>)}</div> : <p className="muted">No calendars are available yet.</p>}
    <div className="destination-block"><h3>Calendar for new events</h3><p>Reviewed additions go to this one calendar. This is separate from the calendars read above, and its events are visible to the household.</p>{destination && <p>Saved destination: <strong>{destination.name}</strong></p>}
      <label>Write reviewed plans to<select value={selectedChoice} onChange={(event) => setChoice(event.target.value)} disabled={saving || !loaded || !writable.length}><option value="">Choose a calendar…</option>{writable.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>
      {!selectedChoice && <p className="muted">Select a writable household or personal calendar above and choose it here to enable calendar additions from your account.</p>}
    </div>
    <button className="secondary" disabled={saving || !loaded} onClick={() => void refreshStatus()}>Refresh sync status</button>
    <button disabled={saving || !loaded || !calendars.length} onClick={() => void save()}>{saving ? 'Saving…' : 'Save calendar choices'}</button>
  </section>;
}
