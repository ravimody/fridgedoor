import { scheduleLabel } from '../Home/schedule-time.js';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { trialResponseSchema, type TrialItem, type TrialSummary, trialSummarySchema } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
type Learning = {enabled:boolean;revision:number;preferences:TrialSummary['preferences'];generatedAt:string|null};
export function RelevanceTrial() {
  const [learning,setLearning]=useState<Learning|null>(null);
  const [items, setItems] = useState<TrialItem[]>([]);
  const [summary, setSummary] = useState<TrialSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  async function load() {
    const data = trialResponseSchema.parse(await apiFetch('/relevance-trial')).data;
    const saved=await apiFetch<{data:{result:unknown}|null}>('/relevance-trial/summary');
    setLearning((await apiFetch<{data:Learning}>('/relevance-trial/learning')).data);
    setSummary(saved.data ? trialSummarySchema.parse(saved.data.result) : null);
    setItems(data.items); setLoaded(true);
  }
  useEffect(() => { void load().catch(() => setNotice('Could not load your trial. Reload to try again.')); }, []);
  const current = items.find(item => item.id === selected) ?? items.find(item => item.value === null);
  const completed = items.filter(item => item.value !== null).length;
  async function rate(item: TrialItem, value: 'useful' | 'not_useful' | 'skip', reason: string) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const result = trialResponseSchema.parse(await apiFetch(`/relevance-trial/${item.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value, reason, expectedRevision: item.revision }) }));
      setItems(result.data.items); setSelected(null); setSummary(null); await apiFetch<{data:Learning}>('/relevance-trial/learning').then(response=>setLearning(response.data)).catch(()=>setLearning(null));
      setNotice('Saved. You can change your answers below.');
    } catch { setNotice('Could not save. Your answer is still here; reload if it changed on another device.'); }
    finally { setBusy(false); }
  }
  async function next() {
    setBusy(true); setNotice('');
    try { const data=trialResponseSchema.parse(await apiFetch('/relevance-trial/next',{method:'POST'})).data; setItems(data.items); setSelected(null); if(!data.items.some(item=>item.value===null))setNotice('No more recent suggestions available to sample.'); }
    catch { setNotice('Could not load another batch. Try again.'); }
    finally { setBusy(false); }
  }
  async function compact() {
    setBusy(true); setNotice('');
    try { const response=await apiFetch<{data:{result:unknown}}>('/relevance-trial/summary',{method:'POST'}); setSummary(trialSummarySchema.parse(response.data.result)); }
    catch { setNotice('Could not summarize yet. Your ratings are saved. Try again after rating some examples.'); }
    finally { setBusy(false); }
  }
  async function updateLearning(forget = false) {
    if(!learning || busy) return;
    setBusy(true);setNotice('');
    try {
      const result=await apiFetch<{data:Learning}>(forget?'/relevance-trial/learning/forget':'/relevance-trial/learning',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(forget?{expectedRevision:learning.revision}:{enabled:!learning.enabled,expectedRevision:learning.revision,consentVersion:'personal-relevance-v1'})});
      setLearning(result.data);setNotice(forget?'Learned preferences forgotten. Earlier votes will not relearn them unless you change those votes.':result.data.enabled?'Nightly learning is on. New feedback will be considered overnight.':'Nightly learning is paused; your morning review uses the shared guidance.');
    } catch {setNotice('Could not update learning. Reload and try again.');}
    finally {setBusy(false);}
  }
  async function clear() {
    setBusy(true);
    try { await apiFetch('/relevance-trial', { method: 'DELETE' }); setItems([]); setSelected(null); setSummary(null); setLearning({enabled:false,revision:0,preferences:[],generatedAt:null}); setNotice('Examples, ratings and learned preferences deleted.'); }
    catch { setNotice('Could not delete the trial. Try again.'); }
    finally { setBusy(false); }
  }
  return <main className="page"><Link to="/">← Home</Link><h1>What belongs on your Home?</h1>
    <p>These are real recent suggestions, shown as they appeared. Would each be useful to you? A reason is optional.</p>
    <p>Your answers are private to you. Examples and ratings are saved for 30 days. Rating something does not dismiss or delete its plan.</p>
    {learning && <section className="card"><h2>Learn what matters to me</h2><p>With nightly learning on and Daily AI enabled, the AI provider summarizes your rated examples, authorized source excerpts and optional reasons into private preferences. These guide optional morning suggestions. Your commitments, important deadlines and reminders stay visible.</p><p>Examples expire after 30 days; learned preferences stay until you forget them. A single unexplained vote stays tentative.</p><button disabled={busy} onClick={()=>void updateLearning()}>{learning.enabled?'Pause nightly learning':'Turn on nightly learning'}</button>
      {learning.preferences.length>0 ? <><h3>My learned preferences</h3><ul>{learning.preferences.map((rule,i)=><li key={i}>{rule.direction==='prefer'?'Usually include':'Usually omit'}: {rule.pattern}</li>)}</ul></> : <p>No established personal exceptions yet. Shared guidance already keeps routine clutter out of the morning review.</p>}
      <button className="secondary" disabled={busy || !learning.preferences.length} onClick={()=>void updateLearning(true)}>Forget learned preferences</button>
    </section>}
    {loaded && <section className="card"><button disabled={busy || items.some(item=>item.value===null)} onClick={()=>void next()}>Try 5 random suggestions</button><p>Finish this batch to get five more. Your earlier ratings stay saved.</p>
      {completed>0 && <><p>Summarizing sends your saved suggestion summaries, authorized source excerpts, ratings and optional reasons to the AI provider. The result is a draft of your preferences, not an active filter.</p><button disabled={busy} onClick={()=>void compact()}>{busy?'Working…':'Summarize my feedback'}</button></>}
      {summary && <section><h2>My draft preferences</h2><p>{summary.overview}</p><ul>{summary.preferences.map((rule,i)=><li key={i}><p><strong>{rule.direction==='prefer'?'Useful':rule.direction==='avoid'?'Usually omit':'Still uncertain'}:</strong> {rule.pattern}</p><small>Based on {rule.evidenceIds.length} rated example{rule.evidenceIds.length===1?'':'s'}</small></li>)}</ul><p>Draft only. This preview does not apply new preferences. Nightly learning applies only well-supported personal exceptions. Change any rating and summarize again to revise this draft.</p></section>}
    </section>}
    {notice && <p role="status">{notice}</p>}
    {!loaded ? <p>Loading your examples…</p> : !items.length ? <p>No trial is prepared for your account.</p> : <>
      <p>{completed} of {items.length} answered</p>
      {current ? <TrialCard key={`${current.id}:${current.revision}`} item={current} busy={busy} onRate={rate} /> : <section className="card"><h2>Thanks, your ratings are saved.</h2><p>Turn on nightly learning above to personalize future morning reviews. You can change any answer.</p></section>}
      {completed > 0 && <section className="card"><h2>Your answers</h2><ul>{items.filter(item => item.value !== null).map(item => <li key={item.id}><p>{item.facts.title} · {item.value === 'useful' ? 'Useful' : item.value === 'not_useful' ? 'Not useful' : 'Skipped'}</p><button className="secondary" disabled={busy} onClick={() => setSelected(item.id)}>Change answer</button></li>)}</ul></section>}
      <details><summary>Delete trial data</summary><p>This removes these examples, ratings and learned preferences, and turns off nightly learning.</p><button className="secondary" disabled={busy} onClick={() => void clear()}>Delete trial and ratings</button></details>
    </>}
  </main>;
}
function TrialCard({ item, busy, onRate }: { item: TrialItem; busy: boolean; onRate: (item: TrialItem, value: 'useful' | 'not_useful' | 'skip', reason: string) => Promise<void> }) {
  const [reason, setReason] = useState(item.reason);
  return <section className="card capture-card"><p>Suggested {new Date(item.observedAt).toLocaleDateString()}</p><h2>{item.facts.title}</h2><p>Source: {item.source?.sender ?? (item.source?.available ? 'Your email' : 'Original email unavailable')}</p>{item.source?.excerpt && <details><summary>See source excerpt</summary><p>{item.source.excerpt}</p></details>}
    {item.facts.time && <p>{scheduleLabel(item.facts.time, Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>}
    {item.facts.notes && <p>{item.facts.notes}</p>}
    {item.facts.preparationTasks.length > 0 && <ul>{item.facts.preparationTasks.map((task, i) => <li key={i}>{task}</li>)}</ul>}
    <div className="button-row"><button disabled={busy} onClick={() => void onRate(item, 'useful', reason)}>Useful</button><button className="secondary" disabled={busy} onClick={() => void onRate(item, 'not_useful', reason)}>Not useful</button><button className="secondary" disabled={busy} onClick={() => void onRate(item, 'skip', reason)}>Skip</button></div>
    <details><summary>Add a reason (optional)</summary><label>What should we learn?<textarea value={reason} maxLength={500} disabled={busy} onChange={event => setReason(event.target.value)} /></label><p>Choose a button above to save your answer and reason.</p></details>
  </section>;
}
