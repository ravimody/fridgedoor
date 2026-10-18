import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AssistantRun, DailyOverview, KnowledgeProposal, PlanSummary } from '@fridgedoor/contracts';
import { apiFetch } from '../../api/client.js';
import { registerNotificationWorker } from '../Settings/notification-worker.js';
type Fact = { key: string; value: string; revision: number; provenance: 'legacy'|'user'|'source'|'maintenance'; confirmation: 'confirmed'|'unconfirmed'; validFrom: string | null; validUntil: string | null; relationKey: string | null; archivedAt: string | null };
type KnowledgeChange = { id: string; key: string; baseRevision: number; resultRevision: number; before: string | null; after: string | null; origin: 'user'|'review'|'maintenance'; reason: string; createdAt: string; undoUntil: string };
type AgendaItem = { id: string; title: string; location?: string; time: PlanSummary['facts']['time']; origin: string; planId?: string; status: 'confirmed' | 'tentative' };
type Todo = { id: string; title: string; completedAt: string | null; dueTime?: string; snoozedUntil?:string; revision:number };
export type DailyView = { state: 'ready' | 'fallback' | 'unavailable'; result: DailyOverview; items: (DailyOverview['items'][number] & { title: string; normalizedTime: PlanSummary['facts']['time']; sourceRefs: string[]; targets?: {kind:string;id:string}[]; href: string | null })[]; generatedAt: string | null; coverage: { channel: string; status: string; lastSuccessAt: string | null; omittedCount: number }[]; revision: number; errorCode?: string };
type Clarification = { id: string; question: string; reason: string; sourceRefs: string[]; state: 'open'|'answered'|'dismissed'|'expired'; answer: string | null; revision: number; createdAt: string; expiresAt: string };
type Data = { runs: AssistantRun[]; knowledge: Fact[]; knowledgeHistory: KnowledgeChange[]; knowledgeProposals: KnowledgeProposal[]; plans: PlanSummary[]; agenda: AgendaItem[]; todos: Todo[]; reminders: { id: string; dueAt: string; state: string; revision: number; parentType: string; parentId: string; title?: string }[]; settings: { enabled: boolean; consent: boolean }; connection: { status?: string; provider?: 'google' | 'imap' }; destination: { name: string; ownCalendarSelectionId?: string | null } | null; dailyOverview: DailyView | null; dailySettings: { enabled: boolean; consentVersion: string | null; revision: number; available: boolean; disclosureVersion: string }; clarifications: Clarification[] };
const initial: Data = { runs: [], knowledge: [], knowledgeHistory: [], knowledgeProposals: [], plans: [], agenda: [], todos: [], reminders: [], settings: { enabled: false, consent: false }, connection: {}, destination: null, dailyOverview: null, dailySettings: { enabled: false, consentVersion: null, revision: 0, available: false, disclosureVersion: 'daily-assistant-v1' }, clarifications: [] };
const messages: Record<string, string> = { UNDO_UNAVAILABLE: 'Undo is unavailable. You can manage the item in To do or Groceries.', AUTH_REQUIRED: 'Your sign-in expired. Reload to sign in again.', FORBIDDEN: 'That isn’t allowed for your account. If you think it should be, reload the page and try again.', DESTINATION_NOT_ALLOWED: 'Choose a writable calendar in Settings → Calendar. Your proposal is still here.', PLAN_TIME_INCOMPLETE: 'Add the missing date or time, or keep this in the planner for later.', STALE_REVISION: 'This item changed. Review its latest details before changing it.', STALE_CLIENT: 'This page is out of date. Reload it before changing a fact.', UNSUPPORTED_HEIC_CONVERSION: 'Export this HEIC photo as JPEG or PNG and try again.', CAPTURE_TOO_LARGE: 'Choose a file smaller than 10 MB.', KNOWLEDGE_LIMIT: 'Edit or forget an existing fact before adding another. The limit is 50.', ASSISTANT_BUSY: 'Several requests are waiting. Let them finish, then send this one.', CAPTURE_STORAGE_FULL: 'Files you sent are still waiting to be read. Wait a few minutes, then send this one.', PAYLOAD_TOO_LARGE: 'That’s too long to send. Shorten it and try again.', PROPOSAL_EXPIRED: 'This suggestion expired. Ask the planner again if you still want it.', INTERNAL: 'Something went wrong. Try again in a moment.' };
function usePlannerState(timezone: string, onExpired?: () => void) {
  const expired = useRef(onExpired); useEffect(() => { expired.current = onExpired; }, [onExpired]);
  const dismissing = useRef(false);
  const [morningUndo, setMorningUndo] = useState<{token:string;expiresAt:number}|null>(null);
  useEffect(()=>{if(!morningUndo)return;const timer=setTimeout(()=>setMorningUndo(null),Math.max(0,morningUndo.expiresAt-Date.now()));return()=>clearTimeout(timer);},[morningUndo]);
  const refreshVersion = useRef(0); const acting = useRef(false);
  const [data, setData] = useState<Data>(initial); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false); const [composerOpen, setComposerOpen] = useState(false); const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const clientId = crypto.randomUUID();
    if ('serviceWorker' in navigator) void registerNotificationWorker().catch(() => {});
    const pulse = () => { void post('/assistant/presence', { clientId, visible: document.visibilityState === 'visible' }).catch(() => {}); };
    pulse(); const timer = setInterval(pulse, 15000); document.addEventListener('visibilitychange', pulse);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', pulse); void post('/assistant/presence', { clientId, visible: false }).catch(() => {}); };
  }, []);
  const priorActions = useRef(new Map<string, string>());
  useEffect(() => {
    for (const plan of data.plans) {
      const action = plan.calendarAction;
      if (action?.state === 'succeeded' && priorActions.current.has(action.actionId) && priorActions.current.get(action.actionId) !== 'succeeded') setNotice(`${action.kind === 'update' ? 'Updated' : action.kind === 'cancel' ? 'Removed' : 'Added'} “${plan.facts.title}” ${action.kind === 'cancel' ? 'from' : 'on'} the household calendar.`);
      if (action) priorActions.current.set(action.actionId, action.state);
    }
  }, [data.plans]);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const routes = { reminders: '/reminders', runs: '/assistant/runs', knowledge: '/assistant/knowledge', knowledgeHistory: '/assistant/knowledge/history', knowledgeProposals: '/assistant/knowledge/proposals', plans: '/plans', agenda: '/agenda', todos: '/lists/todo', settings: '/assistant/settings', connection: '/connection', destination: '/destination', dailyOverview: '/daily-overview', dailySettings: '/daily-ai-settings', clarifications: '/clarifications' };
    const results = await Promise.allSettled(Object.entries(routes).map(async ([key, route]) => {
      const response = await apiFetch<{ data: unknown }>(route);
      const value = key === 'reminders' ? (response.data as { reminders: unknown[] }).reminders : key === 'plans' ? (response.data as { plans: PlanSummary[] }).plans : ['agenda', 'todos'].includes(key) ? (response.data as { items: unknown[] }).items : response.data;
      if (['runs', 'knowledge', 'knowledgeHistory', 'knowledgeProposals', 'plans', 'agenda', 'todos', 'reminders', 'clarifications'].includes(key) && !Array.isArray(value)) throw new Error('INVALID_RESPONSE');
      if (['dailyOverview', 'dailySettings'].includes(key) && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('INVALID_RESPONSE');
      return { key, value };
    }));
    if (version !== refreshVersion.current) return;
    if (results.some((result) => result.status === 'rejected' && result.reason instanceof Error && result.reason.message === 'AUTH_REQUIRED')) throw new Error('AUTH_REQUIRED');
    setData((current) => { const next = { ...current }; for (const result of results) if (result.status === 'fulfilled' && !(result.value.key === 'dailyOverview' && dismissing.current)) Object.assign(next, { [result.value.key]: result.value.value }); return next; });
    setLoaded(true);
    if (results.every((result) => result.status === 'rejected')) throw new Error('REFRESH_FAILED');
  }, []);
  // An expired session goes back to sign-in. Polling stops while the page is hidden and catches up when it's shown again.
  const failed = useCallback((error: unknown, message: string) => { if (error instanceof Error && error.message === 'AUTH_REQUIRED' && expired.current) expired.current(); else setNotice(message); }, []);
  useEffect(() => {
    const poll = () => { if (!document.hidden) void refresh().catch((error: unknown) => failed(error, 'Could not refresh. Your saved requests remain on the server.')); };
    poll(); const timer = setInterval(poll, 3000); document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [refresh, failed]);
  async function act(action: () => Promise<unknown>) { if (acting.current) return false; acting.current = true; setBusy(true); setNotice(''); try { await action(); await refresh().catch((error: unknown) => failed(error, 'Saved. Could not refresh the view yet; reload to see the latest state.')); return true; } catch (error) { failed(error, messages[error instanceof Error ? error.message : ''] ?? 'That did not complete. Your input and saved requests are still available; try again.'); return false; } finally { acting.current = false; setBusy(false); } }
  async function dismissMorningItem(refs: string[], expectedRevision: number) {
    if (acting.current || !data.dailyOverview) return false;
    const previous = data.dailyOverview;
    acting.current = true; dismissing.current = true; ++refreshVersion.current; setBusy(true); setNotice('');
    const matches = (item: {refs:string[]}) => item.refs.some(ref => refs.includes(ref));
    setData(current => ({...current, dailyOverview:current.dailyOverview ? {...current.dailyOverview,
      items:current.dailyOverview.items.filter(item=>!matches(item)),
      result:{...current.dailyOverview.result,summary:'Your remaining morning review.',items:current.dailyOverview.result.items.filter(item=>!matches(item)),questions:current.dailyOverview.result.questions.filter(item=>!matches(item))},
    } : null}));
    try {
      const response = await apiFetch<{data:DailyView & {undoToken?:string}}>('/daily-overview/dismiss',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refs,expectedRevision})});
      ++refreshVersion.current;
      setData(current => ({...current,dailyOverview:response.data}));
      setMorningUndo(response.data.undoToken ? {token:response.data.undoToken,expiresAt:Date.now()+290_000}:null);
      return true;
    } catch (error) {
      ++refreshVersion.current;
      setData(current => ({...current,dailyOverview:previous}));
      setNotice(error instanceof Error && error.message === 'TASK_REQUIRES_ACTION' ? 'This is a to-do. Mark it done or choose Later instead.' : 'Could not dismiss this item. It has been restored; please try again.');
      return false;
    } finally {acting.current=false;dismissing.current=false;setBusy(false);}
  }
  async function undoMorningDismiss() {
    if(acting.current || !morningUndo)return;
    acting.current=true;dismissing.current=true;++refreshVersion.current;setBusy(true);setNotice('');
    try {
      const response=await apiFetch<{data:DailyView}>('/daily-overview/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({undoToken:morningUndo.token})});
      ++refreshVersion.current;setData(current=>({...current,dailyOverview:response.data}));setMorningUndo(null);
    } catch(error) { if(error instanceof Error && error.message==='UNDO_UNAVAILABLE')setMorningUndo(null);setNotice('Could not restore this review item. It may have changed or Undo may have expired.'); }
    finally {acting.current=false;dismissing.current=false;setBusy(false);}
  }
  return { ...data, morningUndo, undoMorningDismiss, timezone, notice, setNotice, busy, act, refresh, dismissMorningItem, composerOpen, setComposerOpen, loaded };
}
const Context = createContext<ReturnType<typeof usePlannerState> | null>(null);
export function PlannerProvider({ children, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, onExpired }: { children: ReactNode; timezone?: string; onExpired?: () => void }) { const value = usePlannerState(timezone, onExpired); return <Context.Provider value={value}>{children}</Context.Provider>; }
export function usePlanner() { const value = useContext(Context); if (!value) throw new Error('PlannerProvider missing'); return value; }
export const post = (path: string, body: unknown = {}) => apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
