import { DateTime } from 'luxon';
import { useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listResponseSchema, type ListItem } from '@fridgedoor/contracts';
import { usePlanner } from '../Home/PlannerContext.js';
import { TaskActions } from './TaskActions.js';
import { ReminderEditor } from '../Reminders/ReminderEditor.js';
import { apiFetch } from '../../api/client.js';

export function Lists({initialKind}:{initialKind?:'grocery'|'todo'}) {
  const {timezone}=usePlanner();
  const [params]=useSearchParams();
  const [kind,setKind]=useState<'grocery'|'todo'>(initialKind ?? (params.get('kind')==='todo'?'todo':'grocery'));
  const [items,setItems]=useState<ListItem[]>([]);
  const [title,setTitle]=useState('');
  const [notice,setNotice]=useState('');
  const [loaded,setLoaded]=useState(false);
  const [saving,setSaving]=useState<string|null>(null);
  const requestVersion=useRef(0);
  const pending=useRef(false);
  const load=useCallback(()=>{
    const version=++requestVersion.current;
    return apiFetch<unknown>(`/lists/${kind}`).then(response=>{
      const result=listResponseSchema.parse(response);
      if(version===requestVersion.current){setItems(result.data.items);setLoaded(true);}
    }).catch(()=>{if(version===requestVersion.current)setNotice('Could not load this list. Reload to try again.');});
  },[kind]);
  useEffect(()=>{void load();const requests=requestVersion;return()=>{++requests.current;};},[load]);
  function choose(next:'grocery'|'todo'){if(next===kind)return;setItems([]);setLoaded(false);setNotice('');setKind(next);}
  async function add() {
    if(!loaded || !title.trim() || pending.current)return;
    pending.current=true;setSaving('new');setNotice('');
    const version=requestVersion.current;
    try {
      const result=await apiFetch<{data:ListItem}>(`/lists/${kind}/items`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':`web-${kind}-${crypto.randomUUID()}`},body:JSON.stringify({title:title.trim()})});
      if(version===requestVersion.current){setItems(current=>[result.data,...current]);setTitle('');}
    } catch {if(version===requestVersion.current)setNotice('The item could not be saved.');}
    finally {pending.current=false;setSaving(null);}
  }
  function saved(updated?:ListItem) {
    if(updated)setItems(current=>current.map(item=>item.id===updated.id?updated:item));
    else return load();
  }
  async function toggle(item:ListItem) {
    if(pending.current)return;
    pending.current=true;setSaving(item.id);setNotice('');
    const version=requestVersion.current;
    // Move a checked grocery out of the active list immediately; restore on failure.
    setItems(current=>current.map(value=>value.id===item.id?{...value,completedAt:item.completedAt?null:new Date().toISOString()}:value));
    try {
      const result=await apiFetch<{data:ListItem}>(`/list-items/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:item.revision,completed:!item.completedAt})});
      if(version===requestVersion.current)setItems(current=>current.map(value=>value.id===item.id?result.data:value));
    } catch {
      if(version===requestVersion.current){setItems(current=>current.map(value=>value.id===item.id?item:value));setNotice('Could not save. The item has been restored; refresh and try again.');}
    } finally {pending.current=false;setSaving(null);}
  }
  const active=items.filter(item=>!item.completedAt);
  const completed=items.filter(item=>item.completedAt).sort((a,b)=>b.completedAt!.localeCompare(a.completedAt!));
  const date=(value:string)=>DateTime.fromISO(value,{zone:timezone}).toFormat(value.includes('T')?'LLL d, yyyy · h:mm a':'LLL d, yyyy');
  return <main className="page">
    <p className="eyebrow">Shared household list</p>
    <h1>{initialKind ? kind==='grocery'?'Groceries':'To do' : 'Household lists'}</h1>
    <p className="muted">Everyone in your household can view and update this list.</p>
    {!initialKind && <div className="button-row"><button className={kind==='grocery'?'':'secondary'} onClick={()=>choose('grocery')}>Groceries</button><button className={kind==='todo'?'':'secondary'} onClick={()=>choose('todo')}>To do</button></div>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <section className="card list-card" aria-label="Active items">
      <form onSubmit={event=>{event.preventDefault();void add();}} className="list-add">
        <label>Add an item<input disabled={!loaded} value={title} onChange={event=>setTitle(event.target.value)} placeholder={kind==='grocery'?'Milk':'Call school'} /></label>
        <button disabled={!loaded || saving!==null || !title.trim()}>Add</button>
      </form>
      {active.length ? <ul className="list-items">{active.map(item=><li key={item.id}>
        {kind==='grocery'?<label className="grocery-check"><input type="checkbox" checked={false} disabled={saving!==null} onChange={()=>void toggle(item)} /><span>{item.title}{item.quantity?` · ${item.quantity}`:''}</span></label>:<strong>{item.title}</strong>}
        {item.snoozedUntil && <span className="muted">Remind on {date(item.snoozedUntil)}</span>}
        {kind==='todo'?<TaskActions item={item} timezone={timezone} onSaved={saved}/>:<ReminderEditor parentType="list_item" parentId={item.id}/>}
      </li>)}</ul>:<p className="muted">{!loaded?'Loading your list…':completed.length?'All done for now.':'Nothing here yet.'}</p>}
    </section>
    {completed.length>0 && <details className="completed-list card">
      <summary>Completed <span>{completed.length}</span></summary>
      <ul className="list-items">{completed.map(item=><li key={item.id}>
        <div className="completed-copy"><strong>{item.title}{item.quantity?` · ${item.quantity}`:''}</strong><small>Completed {date(item.completedAt!)}</small><small>Added {date(item.createdAt)}</small>{item.dueTime && <small>Reminder date {date(item.dueTime)}</small>}</div>
        <button className="secondary" aria-label={`Reopen ${item.title}`} disabled={saving!==null} onClick={()=>void toggle(item)}>Reopen</button>
      </li>)}</ul>
    </details>}
  </main>;
}
