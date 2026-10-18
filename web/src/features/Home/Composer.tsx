import { outcomeLabels, requestOutcomes } from '@fridgedoor/contracts';
import { AddedListItem } from './AddedListItem.js';
import { VoiceInput } from './VoiceInput.js';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiFetch } from '../../api/client.js';
import { post, usePlanner } from './PlannerContext.js';
export function Composer() {
  const planner = usePlanner(); const navigate = useNavigate(); const dialog = useRef<HTMLDialogElement>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [sentId, setSentId] = useState<string>();
  const [text, setText] = useState(''); const [file, setFile] = useState<File>(); const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<{ clientId: string; text: string; file?: File; captureId?: string } | undefined>(undefined);
  useEffect(() => { if (planner.composerOpen) dialog.current?.showModal(); else dialog.current?.close(); }, [planner.composerOpen]);
  async function send(message = text) {
    if (!message.trim() && !file) return;
    let runId: string | undefined;
    const saved = await planner.act(async () => {
      if (!pending.current || pending.current.text !== message || pending.current.file !== file) pending.current = { clientId: crypto.randomUUID(), text: message, ...(file ? { file } : {}) };
      const submission = pending.current;
      if (file && !submission.captureId) { const body = new FormData(); body.set('clientCaptureId', submission.clientId); body.set('file', file); const response = await apiFetch<{ data: { captureId: string } }>('/captures', { method: 'POST', body }); submission.captureId = response.data.captureId; }
      const response = await post('/assistant/runs', { clientId: submission.clientId, text: message.trim(), ...(submission.captureId ? { captureId: submission.captureId } : {}) }) as { data: { id: string } };
      runId = response.data.id;
      pending.current = undefined; setText(''); setFile(undefined); if (fileInput.current) fileInput.current.value = '';
    });
    if (saved) { planner.setComposerOpen(false); navigate('/'); setSentId(runId); planner.setNotice(''); }
  }
  const sentRun = planner.runs.find((run) => run.id === sentId);
  const automatic = sentRun?.reviews?.filter((entry) => entry.automatic) ?? [];
  return <>{sentId && !planner.composerOpen && <div className="submission-receipt" role="status">{automatic.length && sentRun ? automatic.map((entry) => <AddedListItem key={entry.target} run={sentRun} index={Number(entry.target.split(':')[1])} />) : sentRun ? requestOutcomes(sentRun, planner.plans).map((outcome) => outcomeLabels[outcome]).join(' · ') : 'Sent. '} {automatic.length > 0 && sentRun && requestOutcomes(sentRun, planner.plans).filter((outcome) => !['added', 'undone'].includes(outcome)).map((outcome) => <span key={outcome}>{outcomeLabels[outcome]}</span>)}<Link to={`/requests/${sentId}`}>View request</Link><button className="secondary" aria-label="Dismiss receipt" onClick={() => setSentId(undefined)}>×</button></div>}<button className="composer-launch" onClick={() => planner.setComposerOpen(true)}>Ask, add, or share…</button>
    <dialog ref={dialog} className="composer-dialog" aria-labelledby="composer-title" onCancel={() => planner.setComposerOpen(false)}><div className="dialog-heading"><h2 id="composer-title">What’s on your mind?</h2><button className="secondary" onClick={() => planner.setComposerOpen(false)}>Close</button></div>
      {planner.notice && <p role="status" className="notice">{planner.notice}</p>}
      {!planner.loaded ? <p>Loading…</p> : !planner.settings.enabled ? <p>The planner is unavailable. Your plans and lists still work.</p> : !planner.settings.consent ? <><p>Your messages, uploads, relevant plans and lists, and your household facts are sent to your household's AI provider. Public lookups send minimal search terms. Requests and results expire after seven days; household facts stay until you delete them. The provider may keep API data for a while under its own policy. Browser dictation may use your browser’s speech service. This does not enable email scanning.</p><button disabled={planner.busy} onClick={() => void planner.act(() => post('/assistant/settings', { enabled: true }))}>Turn on for my account</button></> : <div className="capture-card"><label>Message or recipe link<textarea autoFocus rows={4} maxLength={8000} value={text} disabled={planner.busy || voiceBusy} onChange={(event) => setText(event.target.value)} placeholder="Drinks with Bob on Monday at 6…" /></label><label>Photo or PDF<input ref={fileInput} type="file" disabled={planner.busy || voiceBusy} accept="image/jpeg,image/png,image/heic,image/heif,application/pdf" onChange={(event) => setFile(event.target.files?.[0])} /></label><VoiceInput active={planner.composerOpen} disabled={planner.busy} onBusy={setVoiceBusy} onText={async (words, autoSend) => { const combined = `${text}${text.trim() ? '\n' : ''}${words}`; if (combined.length > 8000) throw new Error('INPUT_TOO_LONG'); setText(combined); if (autoSend) await send(combined); }} /><p className="muted">Direct list commands are added with Undo. Other changes wait for review.</p><button disabled={planner.busy || voiceBusy || (!text.trim() && !file)} onClick={() => void send()}>{planner.busy ? 'Saving…' : 'Send'}</button></div>}
    </dialog></>;
}
