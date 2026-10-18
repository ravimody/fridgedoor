import { useState } from 'react';
import { apiFetch } from '../../api/client.js';
import { post, usePlanner } from './PlannerContext.js';
export function Household() {
  const [now] = useState(() => Date.now());
  const planner = usePlanner(); const [query, setQuery] = useState(''); const [key, setKey] = useState(''); const [value, setValue] = useState('');
  const currentFact = planner.knowledge.find((fact) => fact.key === key);
  const ownerToday = new Intl.DateTimeFormat('en-CA', { timeZone: planner.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const proposalValue = (proposal: typeof planner.knowledgeProposals[number]) => proposal.proposedValue ?? (proposal.operation === 'archive' ? 'Archived' : 'Nothing');
  const currentValue = (proposal: typeof planner.knowledgeProposals[number]) => planner.knowledge.find((fact) => fact.key === proposal.targetKeys[0])?.value ?? 'Nothing';
  return <main className="page"><p className="eyebrow">What the planner knows</p><h1>Household facts</h1><p>These facts are private to your account. Correct or forget them anytime. Include dates for changes such as switching schools.</p>
    {!!planner.knowledgeProposals.length && <section className="card capture-card" aria-labelledby="knowledge-proposals-heading"><h2 id="knowledge-proposals-heading">Suggested updates to household facts</h2><p>Review the suggested change and its source before saving it.</p>{planner.knowledgeProposals.map((proposal) => <article key={proposal.id}><strong>{proposal.targetKeys.join(', ').replaceAll('_', ' ')}</strong><p><span>{currentValue(proposal)}</span> → <span>{proposalValue(proposal)}</span></p><p>{proposal.reason}</p><p className="muted">Source: {proposal.provenanceRefs.join(', ')}</p><div className="button-row"><button disabled={planner.busy} onClick={() => void planner.act(() => post(`/assistant/knowledge/proposals/${proposal.id}/accept`))}>Accept</button><button className="secondary" disabled={planner.busy} onClick={() => void planner.act(() => post(`/assistant/knowledge/proposals/${proposal.id}/dismiss`))}>Dismiss</button></div></article>)}</section>}
    <section className="card capture-card"><label>Search facts<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="School, food, names…" /></label>
      {planner.knowledge.filter((fact) => `${fact.key} ${fact.value}`.toLowerCase().includes(query.toLowerCase())).map((fact) => <article key={fact.key}><strong>{fact.key.replaceAll('_', ' ')}</strong>{fact.validFrom && fact.validFrom > ownerToday && <span className="muted"> · Future</span>}<p>{fact.value}</p><div className="button-row"><button className="secondary" onClick={() => { setKey(fact.key); setValue(fact.value); }}>Edit</button><button className="secondary" disabled={planner.busy} onClick={() => void planner.act(() => apiFetch(`/assistant/knowledge/${encodeURIComponent(fact.key)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: fact.revision }) }))}>Forget</button></div></article>)}
      {!planner.knowledge.length && <p>No remembered facts yet. Add one below or tell the planner.</p>}
    </section><section className="card capture-card"><h2>{currentFact ? 'Edit fact' : 'Add a fact'}</h2><label>Fact name<input maxLength={80} value={key} onChange={(event) => setKey(event.target.value)} placeholder="Dietary preference" /></label><label>Details<textarea maxLength={500} value={value} onChange={(event) => setValue(event.target.value)} placeholder="A concise fact, with dates if relevant" /></label><button disabled={planner.busy || !key.trim() || !value.trim()} onClick={() => void planner.act(async () => { await post('/assistant/knowledge', { key: key.trim(), value: value.trim(), expectedRevision: currentFact?.revision ?? 0 }); setKey(''); setValue(''); })}>Save fact</button></section>
    {!!planner.knowledgeHistory.length && <section className="card"><h2>Recent changes</h2>{planner.knowledgeHistory.slice(0, 20).map((change) => {
      const fact = planner.knowledge.find((item) => item.key === change.key);
      // Upkeep archives a fact without changing its value; the archived fact drops out of the list, so its revision comes from the change, provided nothing changed it since (history is newest first).
      const archived = change.origin === 'maintenance' && change.before !== null && change.before === change.after && !fact;
      const latest = planner.knowledgeHistory.find((item) => item.key === change.key) === change;
      const revision = archived ? (latest ? change.resultRevision : undefined) : fact?.revision;
      const canUndo = revision === change.resultRevision && Date.parse(change.undoUntil) > now;
      return <p key={change.id}><strong>{change.key.replaceAll('_', ' ')}</strong>: {archived ? <>Archived · {change.before}</> : <>{change.before ?? 'Nothing'} → {change.after ?? 'Forgotten'}</>} <span className="muted">({new Date(change.createdAt).toLocaleString()})</span>{canUndo && <button className="secondary" disabled={planner.busy} onClick={() => void planner.act(() => post(`/assistant/knowledge/history/${change.id}/undo`, { expectedRevision: change.resultRevision }))}>Undo</button>}</p>;
    })}</section>}
    {planner.settings.consent && <p><button className="secondary" disabled={planner.busy} onClick={() => void planner.act(() => post('/assistant/settings', { enabled: false }))}>Turn off the planner for my account</button></p>}
  </main>;
}
