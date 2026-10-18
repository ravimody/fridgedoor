import { useEffect, useRef, useState } from 'react';
import type { CalendarFeedStatus, CreatedCalendarFeed } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { errorMessage, FormError } from '../Auth/forms.js';

const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

/**
 * A private subscription link (webcal) that shows the household's plans in Apple, Google or Outlook
 * calendars without connecting any account. The link is only shown when it's made.
 */
export function CalendarFeed({ onCreated }: { onCreated?: () => void }) {
  const [status, setStatus] = useState<CalendarFeedStatus>();
  const [created, setCreated] = useState<CreatedCalendarFeed>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { apiFetch<{ data: CalendarFeedStatus }>('/calendar-feed').then((response) => setStatus(response.data)).catch(() => setError('Could not load your calendar link. Reload to try again.')); }, []);

  async function act(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }
  const create = () => {
    if (status?.active && !window.confirm('Make a new link? The current link stops working, so you’ll need to add the new one to every calendar app that uses it.')) return;
    void act(async () => {
      const next = (await apiFetch<{ data: CreatedCalendarFeed }>('/calendar-feed', { method: 'POST' })).data;
      setCreated(next); setStatus({ active: true, createdAt: new Date().toISOString(), lastFetchedAt: null }); onCreated?.();
    });
  };
  const turnOff = () => {
    if (!window.confirm('Turn off your calendar link? Calendar apps using it will stop showing your plans.')) return;
    void act(async () => { await apiFetch('/calendar-feed', { method: 'DELETE' }); setCreated(undefined); setStatus({ active: false, createdAt: null, lastFetchedAt: null }); setNotice('Calendar link turned off.'); });
  };
  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); setNotice('Link copied.'); }
    catch { field.current?.focus(); field.current?.select(); setNotice('Copying was blocked. Touch and hold the link to copy it.'); }
  }

  return <div className="calendar-feed">
    <p>Subscribe to your plans from the calendar app you already use. You’ll see the household’s shared plans and your own private ones, and they update by themselves. Nothing is connected to your calendar account.</p>
    {!status && !error && <p role="status" className="muted">Loading…</p>}
    {created ? <>
      <div className="button-row"><a className="button primary" href={created.webcalUrl}>Add to Apple Calendar</a></div>
      <label>Your calendar link<input ref={field} readOnly spellCheck={false} value={created.url} onFocus={(event) => event.target.select()} /></label>
      <div className="button-row"><button className="secondary" onClick={() => void copy()}>Copy link</button></div>
      <ul className="feed-steps">
        <li><strong>Google Calendar:</strong> on a computer, open Other calendars → <em>+</em> → From URL, and paste the link.</li>
        <li><strong>Outlook:</strong> Add calendar → Subscribe from web, and paste the link.</li>
      </ul>
      <p className="field-hint">This link is shown only now. Keep it private, like a password: anyone with it can see your plans.</p>
    </> : status?.active && <p>Your calendar link is on. It was made on {formatDay(status.createdAt ?? new Date().toISOString())}{status.lastFetchedAt ? ` and a calendar app last checked it on ${formatDay(status.lastFetchedAt)}` : ', and no calendar app has used it yet'}. For your privacy the link isn’t shown again; make a new one to add it somewhere else.</p>}
    {status && <p className="field-hint">Calendar apps check for changes every hour or so; Google Calendar can take longer. Making a new link turns off the old one.</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <FormError message={error} />
    {status && <div className="button-row">
      <button className={status.active ? 'secondary' : ''} disabled={busy} onClick={create}>{status.active ? 'Make a new link' : 'Make my calendar link'}</button>
      {status.active && <button className="secondary" disabled={busy} onClick={turnOff}>Turn off</button>}
    </div>}
  </div>;
}
