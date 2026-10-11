import { calendarOutcome, outcomeLabels } from '@fridgedoor/contracts';
import { ReminderEditor } from '../Reminders/ReminderEditor.js';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { evidenceResponseSchema, historyResponseSchema, planResponseSchema, type PlanFacts, type PlanSummary } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';

type HistoryEntry = ReturnType<typeof historyResponseSchema.parse>['data']['entries'][number];
type Evidence = ReturnType<typeof evidenceResponseSchema.parse>['data'];

function timeLabel(facts: PlanFacts) {
  if (!facts.time) return 'Time needs review';
  if (facts.time.kind === 'timed') return new Date(facts.time.start).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  if (facts.time.kind === 'deadline') return `Due ${new Date(facts.time.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (facts.time.kind === 'all_day') return `${facts.time.startDate}–${facts.time.endDateExclusive}`;
  if (facts.time.startHint) return `${new Date(facts.time.startHint).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${facts.time.missing.length === 1 && facts.time.missing[0] === 'end' ? 'End time needed' : 'Time needs review'}`;
  return facts.time.dateHint ? `${facts.time.dateHint} · time needs review` : 'Date and time need review';
}

function readableHistory(entry: HistoryEntry) {
  return entry.type.replaceAll('_', ' ');
}

export function PlanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [plan, setPlan] = useState<PlanSummary>();
  const [facts, setFacts] = useState<PlanFacts>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [evidence, setEvidence] = useState<Evidence>();
  const [notice, setNotice] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [timeEdited, setTimeEdited] = useState(false);

  async function load() {
    if (!id) return;
    try {
      const [planResult, historyResult] = await Promise.all([
        apiFetch<unknown>(`/plans/${id}`),
        apiFetch<unknown>(`/plans/${id}/history`),
      ]);
      const nextPlan = planResponseSchema.parse(planResult).data;
      const loadedFacts = nextPlan.pendingFacts ?? nextPlan.facts;
      if (loadedFacts.time?.kind === 'timed') {
        setTimezone(loadedFacts.time.timezone);
        setStart(DateTime.fromISO(loadedFacts.time.start, { zone: loadedFacts.time.timezone }).toFormat("yyyy-MM-dd'T'HH:mm"));
        setEnd(DateTime.fromISO(loadedFacts.time.end, { zone: loadedFacts.time.timezone }).toFormat("yyyy-MM-dd'T'HH:mm"));
      } else if (loadedFacts.time?.kind === 'deadline') {
        setTimezone(loadedFacts.time.timezone);
        setStart(DateTime.fromISO(loadedFacts.time.at, { zone: loadedFacts.time.timezone }).toFormat("yyyy-MM-dd'T'HH:mm"));
        setEnd('');
      } else if (loadedFacts.time?.kind === 'unresolved' && loadedFacts.time.startHint) {
        const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setTimezone(localZone);
        setStart(DateTime.fromISO(loadedFacts.time.startHint, { zone: localZone }).toFormat("yyyy-MM-dd'T'HH:mm"));
        setEnd('');
      } else { setStart(''); setEnd(''); }
      setTimeEdited(false);
      setPlan(nextPlan);
      setFacts(nextPlan.pendingFacts ?? nextPlan.facts);
      setHistory(historyResponseSchema.parse(historyResult).data.entries);
      try {
        setEvidence(evidenceResponseSchema.parse(await apiFetch<unknown>(`/plans/${id}/evidence`)).data);
      } catch {
        setEvidence(undefined);
      }
    } catch {
      setNotice('This plan is unavailable or your secure session has expired.');
    }
  }

  useEffect(() => { void load(); }, [id]);

  function updateFacts(change: Partial<PlanFacts>) {
    setFacts((current) => current ? { ...current, ...change } : current);
  }

  async function save(syncCalendar = false) {
    if (!id || !plan || !facts) return;
    setSaving(true);
    setNotice('');
    try {
      let reviewed = facts;
      if (timeEdited) {
        const from = DateTime.fromISO(start, { zone: timezone }); const to = DateTime.fromISO(end, { zone: timezone });
        const isDeadline = facts.time?.kind === 'deadline' && !end;
        if (!from.isValid || (!isDeadline && (!to.isValid || to <= from))) { setNotice(isDeadline ? 'Choose a valid due time.' : 'Choose a valid start and a later end time.'); return; }
        reviewed = { ...facts, time: isDeadline ? { kind: 'deadline', at: from.toISO()!, timezone } : { kind: 'timed', start: from.toISO()!, end: to.toISO()!, timezone }, unresolvedFields: facts.unresolvedFields.filter((field) => !['time', 'date', 'start', 'end', 'timezone'].includes(field)) };
      }
      const result = planResponseSchema.parse(await apiFetch<unknown>(`/plans/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: plan.revision, facts: reviewed }),
      })).data;
      setTimeEdited(false);
      setPlan(result);
      setFacts(result.pendingFacts ?? result.facts);
      setNotice('Your corrections are saved for review.');
      if (syncCalendar) { await calendarChange('update', result.revision); return; }
      const historyResult = historyResponseSchema.parse(await apiFetch<unknown>(`/plans/${id}/history`));
      setHistory(historyResult.data.entries);
    } catch (error) {
      setNotice(error instanceof Error && error.message === 'STALE_REVISION' ? 'This plan changed elsewhere. Reload it before saving.' : 'The plan could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function calendarChange(kind: 'update' | 'cancel', revision = plan?.revision) {
    if (!id || !revision) return;
    setSaving(true); setNotice('');
    try {
      await apiFetch(`/plans/${id}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `${kind}:${id}:${revision}` }, body: JSON.stringify({ expectedRevision: revision, kind }) });
      setConfirmCancel(false); await load();
    } catch { setNotice('The calendar change could not be queued. Your saved corrections remain here. Check calendar settings and try again.'); }
    finally { setSaving(false); }
  }
  async function decide(choice: 'keep' | 'calendar') {
    if (!id || !plan) return;
    setSaving(true);
    try {
      await apiFetch(`/plans/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: plan.revision, choice }) });
      await load(); setNotice(choice === 'keep' ? 'Kept in planner. No Google event was created.' : 'Calendar addition queued.');
    } catch { setNotice('Could not complete this decision. Check your calendar connection in Settings → Calendar; your plan is still saved.'); }
    finally { setSaving(false); }
  }
  useEffect(() => {
    if (!plan?.calendarAction || ['succeeded', 'failed', 'conflict', 'needs_reauth'].includes(plan.calendarAction.state)) return;
    const timer = setInterval(() => { void apiFetch<{ data: { state: string } }>(`/actions/${plan.calendarAction!.actionId}`).then((response) => { if (response.data.state === 'succeeded') { void load(); } else setPlan((current) => current?.calendarAction ? { ...current, calendarAction: { ...current.calendarAction, state: response.data.state } } : current); }).catch(() => setNotice('Calendar status is temporarily unavailable.')); }, 1000);
    return () => clearInterval(timer);
  }, [plan?.calendarAction?.actionId, plan?.calendarAction?.state]);

  async function dismiss() {
    if (!id || !plan) return;
    try {
      await apiFetch(`/plans/${id}/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: plan.revision }) });
      navigate('/');
    } catch {
      setNotice('This plan changed elsewhere. Reload it before dismissing.');
    }
  }

  async function retryCalendar() {
    if (!plan?.calendarAction) return;
    setSaving(true); setNotice('');
    try { await apiFetch(`/actions/${plan.calendarAction.actionId}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: plan.revision }) }); await load(); }
    catch { setNotice('Could not retry. The original requester must reconnect Google if needed. If the plan has changed, check the original event in Google Calendar before proceeding.'); }
    finally { setSaving(false); }
  }
  if (!plan || !facts) return <main className="page"><Link to="/">← Home</Link><p role="status" className={notice ? 'notice' : 'muted'}>{notice || 'Loading plan…'}</p></main>;
  const hasCalendarEvent = Boolean(plan.calendarAction && (plan.calendarAction.state === 'succeeded' || ['update', 'cancel'].includes(plan.calendarAction.kind ?? 'create')));
  const actionBusy = Boolean(plan.calendarAction && !['succeeded', 'failed', 'conflict', 'needs_reauth'].includes(plan.calendarAction.state));
  const canEdit = !actionBusy && plan.status !== 'dismissed' && plan.status !== 'archived';
  const missing = facts.unresolvedFields.length > 0;
  const dirty = timeEdited || JSON.stringify(facts) !== JSON.stringify(plan.pendingFacts ?? plan.facts);
  return <main className="page detail-page">
    <Link to="/">← Home</Link>
    <p className="eyebrow">Plan review</p>
    <div className="detail-heading"><div><h1>{facts.title}</h1><p className="muted">{plan.visibility === 'private' ? 'Private to you. Adding to the household calendar shares these details.' : 'Shared with the household.'}</p></div><span className={plan.visibility === 'private' ? 'badge private' : 'badge'}>{plan.visibility === 'private' ? 'Only you' : 'Shared'}</span></div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {missing && <p className="notice">Still needs: {facts.unresolvedFields.join(', ')}. Complete the details before applying it to a calendar.</p>}
    <section className="card detail-card"><h2>Details</h2><div className="form-grid">
      <label>Title<input value={facts.title} disabled={!canEdit} onChange={(event) => updateFacts({ title: event.target.value })} /></label>
      <label>Category<input value={facts.category} disabled={!canEdit} onChange={(event) => updateFacts({ category: event.target.value })} /></label>
      <label>Location<input value={facts.location ?? ''} disabled={!canEdit} onChange={(event) => updateFacts({ location: event.target.value || undefined })} /></label>
      <label>Participants<input value={facts.participants.join(', ')} disabled={!canEdit} onChange={(event) => updateFacts({ participants: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></label>
      <label className="full-width">Notes<textarea value={facts.notes ?? ''} disabled={!canEdit} rows={4} onChange={(event) => updateFacts({ notes: event.target.value || undefined })} /></label>
      <label className="full-width">Preparation tasks<textarea value={facts.preparationTasks.join('\n')} disabled={!canEdit} rows={4} onChange={(event) => updateFacts({ preparationTasks: event.target.value.split('\n').map((value) => value.trim()).filter(Boolean) })} /></label>
    </div>
    <p><strong>When:</strong> {timeLabel(facts)}</p>
    {canEdit && <div className="form-grid"><label>{facts.time?.kind === 'deadline' ? 'Due' : 'Start'}<input type="datetime-local" value={start} onChange={(e) => { setStart(e.target.value); setTimeEdited(true); }} /></label><label>{facts.time?.kind === 'deadline' ? 'End (only to make a calendar event)' : 'End'}<input type="datetime-local" value={end} onChange={(e) => { setEnd(e.target.value); setTimeEdited(true); }} /></label><label>Timezone<input value={timezone} onChange={(e) => { setTimezone(e.target.value); setTimeEdited(true); }} /></label></div>}
    {canEdit && <div className="button-row"><button disabled={saving || !dirty} onClick={() => void save(hasCalendarEvent)}>{saving ? 'Saving…' : hasCalendarEvent ? 'Save and update calendar' : 'Save corrections'}</button>{!plan.calendarAction && <><button className="secondary" disabled={saving} onClick={() => void dismiss()}>Dismiss</button><button disabled={saving || dirty || missing || !facts.time || facts.time.kind === 'unresolved' || facts.time.kind === 'deadline'} onClick={() => void decide('calendar')}>Add to household calendar</button>{!plan.savedInPlanner && <button className="secondary" disabled={saving || dirty} onClick={() => void decide('keep')}>Keep in planner</button>}<Link to="/settings/calendar">Calendar settings</Link></>}</div>}
    {canEdit && hasCalendarEvent && <div className="button-row">{!dirty && plan.pendingFacts && <button disabled={saving} onClick={() => void calendarChange('update')}>Update household calendar</button>}{!confirmCancel ? <button className="secondary" disabled={saving} onClick={() => setConfirmCancel(true)}>Remove from calendar</button> : <><p>Remove “{plan.facts.title}” from the shared household calendar?</p><button disabled={saving} onClick={() => void calendarChange('cancel')}>Confirm removal</button><button className="secondary" onClick={() => setConfirmCancel(false)}>Keep event</button></>}</div>}
    {plan.savedInPlanner && !plan.calendarAction && <p>Saved in planner.</p>}
    {plan.calendarAction && <p role="status">{outcomeLabels[calendarOutcome(plan.calendarAction)]}{plan.calendarAction.state === 'conflict' ? ' · The event changed in Google. Your correction has not overwritten it. Review the event in Google Calendar.' : plan.calendarAction.state === 'needs_reauth' ? ' · Reconnect Google in Settings → Email.' : plan.calendarAction.state === 'failed' ? ' · Google has not confirmed this change. Retry checks the original event before writing again.' : ''}</p>}
    {plan.calendarAction && ['failed','needs_reauth'].includes(plan.calendarAction.state) && <div className="button-row"><button disabled={saving || dirty} onClick={() => void retryCalendar()}>Retry original calendar change</button><Link to="/settings/calendar">Calendar settings</Link></div>}
    {plan.calendarAction && <p className="muted">Calendar updates affect the shared event. <a href="https://calendar.google.com/" target="_blank" rel="noreferrer">Open Google Calendar</a></p>}

    </section>
    {canEdit && <section className="card"><ReminderEditor parentType="plan" parentId={plan.id} time={plan.facts.time} /></section>}
    <section className="card detail-card"><h2>Source evidence</h2>{evidence?.availability === 'available' ? <><p className="muted">This evidence is visible only to the source owner.</p>{evidence.sender && <p><strong>From:</strong> {evidence.sender}</p>}{evidence.labels.length > 0 && <p><strong>Labels:</strong> {evidence.labels.join(', ')}</p>}{evidence.text && <pre className="evidence-text">{evidence.text}</pre>}</> : <p className="muted">The original source is expired, deleted, incomplete, or unavailable to this member.</p>}</section>
    <section className="card detail-card"><h2>History</h2>{history.length ? <ol className="history-list">{history.map((entry) => <li key={entry.id}><strong>{readableHistory(entry)}</strong><span>{entry.actorLabel} · {new Date(entry.createdAt).toLocaleString()}</span></li>)}</ol> : <p className="muted">No history is available.</p>}</section>
  </main>;
}
