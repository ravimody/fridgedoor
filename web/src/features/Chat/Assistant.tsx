import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssistantRun } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';

const base = '/assistant';
const post = (path: string, body?: unknown) => apiFetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
export function Assistant() {
  const [settings, setSettings] = useState<{ enabled: boolean; consent: boolean }>();
  const [runs, setRuns] = useState<AssistantRun[]>([]);
  const [knowledge, setKnowledge] = useState<{ key: string; value: string; revision: number }[]>([]);
  const [text, setText] = useState(''); const [file, setFile] = useState<File>();
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [factKey, setFactKey] = useState(''); const [factValue, setFactValue] = useState('');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const pending = useRef<{ clientId: string; text: string; file?: File; captureId?: string } | undefined>(undefined);
  const refresh = async () => {
    const [status, history, facts] = await Promise.all([apiFetch<{ data: { enabled: boolean; consent: boolean } }>(`${base}/settings`), apiFetch<{ data: AssistantRun[] }>(`${base}/runs`), apiFetch<{ data: { key: string; value: string; revision: number }[] }>(`${base}/knowledge`)]);
    setSettings(status.data); setRuns(history.data); setKnowledge(facts.data);
  };
  useEffect(() => {
    let alive = true;
    const poll = () => { if (alive) void refresh().catch(() => { if (alive) setNotice('Could not refresh. Your saved requests remain on the server.'); }); };
    poll(); const timer = setInterval(poll, 3000); return () => { alive = false; clearInterval(timer); };
  }, []);
  async function act(action: () => Promise<unknown>) { setBusy(true); setNotice(''); try { await action(); await refresh(); } catch (error) { const messages: Record<string, string> = { AUTH_REQUIRED: 'Your sign-in expired. Reload to sign in again.', UNSUPPORTED_HEIC_CONVERSION: 'This photo is HEIC. Export it as JPEG or PNG and try again.', CAPTURE_TOO_LARGE: 'Choose a photo or PDF smaller than 10 MB.', KNOWLEDGE_LIMIT: 'There are 50 remembered facts. Edit or forget an existing fact before adding another.', ASSISTANT_BUSY: 'Several requests are waiting. Let them finish, then send this one.' }; setNotice(messages[error instanceof Error ? error.message : ''] ?? 'That did not complete. Your saved requests are still available; try again.'); } finally { setBusy(false); } }
  async function send() {
    if (busy || (!text.trim() && !file)) return;
    await act(async () => {
      if (!pending.current || pending.current.text !== text || pending.current.file !== file) pending.current = { clientId: crypto.randomUUID(), text, ...(file ? { file } : {}) };
      const submission = pending.current;
      if (file && !submission.captureId) {
        const body = new FormData(); body.set('clientCaptureId', submission.clientId); body.set('file', file);
        const result = await apiFetch<{ data: { captureId: string } }>('/captures', { method: 'POST', body }); submission.captureId = result.data.captureId;
      }
      await post('/runs', { clientId: submission.clientId, text: text.trim(), ...(submission.captureId ? { captureId: submission.captureId } : {}) });
      pending.current = undefined; setText(''); setFile(undefined); if (fileInput.current) fileInput.current.value = '';
    });
  }
  return <main className="page assistant-page"><p className="eyebrow">Assistant</p><h1>What’s on your mind?</h1>
    <p className="muted">Send a message, recipe link, school poster, or PDF. Requests stay here even if you close your phone. Review changes before saving.</p>
    {notice && <p role="status" className="notice">{notice}</p>}
    {settings && !settings.enabled && <p className="notice">The assistant is not enabled on the server yet. Plans and lists still work.</p>}
    {settings?.enabled && !settings.consent && <section className="card"><h2>Use the planning assistant</h2><p>Your messages, uploads, relevant plans and lists, and approved remembered facts are sent to your household's AI provider. Public lookups send minimal search terms. Private requests and results expire after seven days; remembered facts stay until you remove them. The provider may keep API data for a while under its own policy. This does not enable email scanning.</p><button disabled={busy} onClick={() => void act(() => post('/settings', { enabled: true }))}>Enable for my account</button></section>}
    {settings?.consent && <section className="card capture-card"><label>Message or recipe link<textarea rows={3} maxLength={8000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Drinks with Bob on Monday at 6…" /></label><label>Photo or PDF<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/heic,image/heif,application/pdf" onChange={(e) => setFile(e.target.files?.[0])} /></label><button disabled={busy || (!text.trim() && !file) || !settings.enabled} onClick={() => void send()}>{busy ? 'Saving…' : 'Send'}</button></section>}
    {runs.map((run) => <section className="card" key={run.id}>
      <p className="muted">{new Date(run.createdAt).toLocaleString()} {run.captureId && ' · Attachment'}</p><p style={{ whiteSpace: 'pre-wrap' }}>{run.text || 'Uploaded photo or PDF'}</p>
      {['queued', 'running'].includes(run.state) && <p role="status">{run.state === 'queued' ? 'Saved. Waiting to process…' : 'Working on it…'}</p>}
      {run.state === 'failed' && <p className="notice">Could not finish ({run.errorCode}). <button disabled={busy} onClick={() => void act(() => post(`/runs/${run.id}/retry`))}>Retry</button></p>}
      {run.result && <><p style={{ whiteSpace: 'pre-wrap' }}>{run.result.reply}</p>
        {run.result.assumptions.length > 0 && <p className="notice">Assumptions: {run.result.assumptions.join(' ')}</p>}
        {run.result.followups.length > 0 && <p className="notice">Needs review: {run.result.followups.join(' ')}</p>}
        <ul>{run.result.items.map((item, index) => <li key={index}><strong>{item.title}</strong> ({item.kind}) {item.quantity}{item.start && <span> · {new Date(item.start).toLocaleString()}</span>}{item.end && <span> – {new Date(item.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}{item.location && <p>{item.location}</p>}{item.notes && <p>{item.notes}</p>}</li>)}</ul>
        {run.result.sources.filter((url) => /^https?:\/\//i.test(url)).map((url, i) => <p key={url}><a href={url} target="_blank" rel="noreferrer">Source {i + 1}: {new URL(url).hostname}</a></p>)}
        {run.result.knowledge.map((fact, i) => <p key={i}>{fact.operation === 'delete' ? 'Forget' : 'Remember'}: {fact.key}{fact.value ? ` — ${fact.value}` : ''}</p>)}
        {!run.applied && (run.result.items.length > 0 || run.result.knowledge.length > 0) && <><p className="muted">Saves list items to the shared household lists, events as private plan drafts, and remembered facts for your account. Calendar changes require Apply on the plan.</p><button disabled={busy} onClick={() => void act(() => post(`/runs/${run.id}/apply`))}>Save these changes</button></>}
        {run.applied && <p>Saved. {run.planIds.map((id, i) => <Link key={id} to={`/plans/${id}`}>Review calendar plan {i + 1} </Link>)}</p>}
        <div className="button-row"><button disabled={busy || run.feedback === 'helpful'} onClick={() => void act(() => post(`/runs/${run.id}/feedback`, { value: 'helpful' }))}>Helpful</button><button disabled={busy || run.feedback === 'needs_work'} onClick={() => void act(() => post(`/runs/${run.id}/feedback`, { value: 'needs_work' }))}>Needs work</button></div>
      </>}
      <details><summary>Request details</summary><p>Run {run.id}</p>{run.metrics && <p>{run.metrics.model} · {(run.metrics.durationMs / 1000).toFixed(1)}s · {run.metrics.inputTokens + run.metrics.outputTokens} tokens · {run.metrics.tools.join(', ') || 'No tools'}</p>}<button disabled={busy} onClick={() => void act(() => apiFetch(`${base}/runs/${run.id}`, { method: 'DELETE' }))}>Delete request</button></details>
    </section>)}
    <details className="card"><summary>Household knowledge</summary><p>Private to your account. Search, correct, or forget facts. Include dates in the text for facts that change over time.</p>
      <label>Search knowledge<input value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)} placeholder="School, food, names…" /></label>
      {knowledge.filter((fact) => `${fact.key} ${fact.value}`.toLowerCase().includes(knowledgeQuery.toLowerCase())).map((fact) => <p key={fact.key}><strong>{fact.key.replaceAll('_', ' ')}:</strong> {fact.value} <button disabled={busy} onClick={() => { setFactKey(fact.key); setFactValue(fact.value); }}>Edit</button> <button disabled={busy} onClick={() => void act(() => apiFetch(`${base}/knowledge/${encodeURIComponent(fact.key)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: fact.revision }) }))}>Forget</button></p>)}
      <label>Fact name<input maxLength={80} value={factKey} onChange={(e) => setFactKey(e.target.value)} placeholder="Dietary preference" /></label><label>Details<textarea maxLength={500} value={factValue} onChange={(e) => setFactValue(e.target.value)} placeholder="A concise fact, with dates if relevant" /></label><button disabled={busy || !factKey.trim() || !factValue.trim()} onClick={() => void act(async () => { await post('/knowledge', { key: factKey.trim(), value: factValue.trim(), expectedRevision: knowledge.find((fact) => fact.key === factKey.trim())?.revision ?? 0 }); setFactKey(''); setFactValue(''); })}>Save fact</button>
      {settings?.consent && <p><button disabled={busy} onClick={() => void act(() => post('/settings', { enabled: false }))}>Disable assistant for my account</button></p>}
    </details>
  </main>;
}
