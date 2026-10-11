import type { ListItem } from '@fridgedoor/contracts';
import { useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { apiFetch } from '../../api/client.js';

type Task = {id:string;title:string;revision:number;completedAt:string|null};
export function TaskActions({item,timezone=Intl.DateTimeFormat().resolvedOptions().timeZone,onSaved}:{item:Task;timezone?:string;onSaved:(updated?:ListItem)=>void|Promise<void>}) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[date,setDate]=useState('');
  const menu=useRef<HTMLDetailsElement>(null);
  const tomorrow=DateTime.now().setZone(timezone).plus({days:1}).toISODate()!;
  async function save(action:'done'|'snooze'|'delete',chosenDate?:string) {
    if(busy)return;setBusy(true);setNotice('');
    try {
      const response=await apiFetch<{data:ListItem}>(`/list-items/${item.id}${action==='snooze'?'/snooze':''}`,{
        method:action==='snooze'?'POST':action==='delete'?'DELETE':'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({expectedRevision:item.revision,...(action==='snooze'?{date:chosenDate}:action==='done'?{completed:true}:{})}),
      });
      if(menu.current)menu.current.open=false;
      await onSaved(action==='delete'?undefined:response?.data);
    } catch {setNotice('Could not save. Refresh the task and try again.');}
    finally {setBusy(false);}
  }
  if(item.completedAt)return null;
  return <div className="task-actions">
    <button className="secondary" disabled={busy} onClick={()=>void save('done')}>Done</button>
    <details ref={menu}><summary>Remind me later</summary><div className="snooze-options">
      {[1,3,7].map(days=><button className="secondary" key={days} disabled={busy} onClick={()=>void save('snooze',DateTime.now().setZone(timezone).plus({days}).toISODate()!)}>{days===1?'Tomorrow':`In ${days} days`}</button>)}
      <label>Choose a date<input type="date" min={tomorrow} value={date} onChange={event=>setDate(event.target.value)} /></label>
      <button disabled={busy||!date||date<tomorrow} onClick={()=>void save('snooze',date)}>Save date</button>
      <button className="secondary" disabled={busy} onClick={()=>void save('delete')}>Delete task</button>
    </div></details>
    {notice && <p role="status">{notice}</p>}
  </div>;
}
