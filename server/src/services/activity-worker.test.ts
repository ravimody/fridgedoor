import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
function setup() {
  const handlers = new Map<string,(event: unknown)=>void>();
  const showNotification = vi.fn().mockResolvedValue(undefined); const openWindow = vi.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync(new URL('../../../web/public/sw.js',import.meta.url),'utf8'), {self:{addEventListener:(type:string,handler:(event:unknown)=>void)=>handlers.set(type,handler),registration:{showNotification},clients:{openWindow}},URL});
  const invoke=async(type:string,event:object)=>{let work:Promise<unknown>=Promise.resolve();handlers.get(type)!({...event,waitUntil:(promise:Promise<unknown>)=>{work=promise;}});await work;};
  return {showNotification,openWindow,invoke};
}
it('shows only fixed notification copy while preserving safe authenticated deep links',async()=>{
  const s=setup();await s.invoke('push',{data:{json:()=>({title:'Fridgedoor review',body:'Private email body',url:'/dashboard/requests/abc-123',tag:'batch'})}});
  expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor review',expect.objectContaining({body:'Review Home for a household update.',data:{url:'/dashboard/requests/abc-123'}}));
  expect(JSON.stringify(s.showNotification.mock.calls)).not.toContain('Private email body');
  await s.invoke('push',{data:{json:()=>({title:'Fridgedoor review',body:'2 calendar suggestions are ready for review.',url:'/dashboard/'})}});
  expect(s.showNotification).toHaveBeenLastCalledWith('Fridgedoor review',expect.objectContaining({body:'2 calendar suggestions are ready for review.'}));
  await s.invoke('notificationclick',{notification:{close:vi.fn(),data:{url:'/dashboard/requests/abc-123'}}});expect(s.openWindow).toHaveBeenCalledWith('/dashboard/requests/abc-123');
});
it.each(['https://evil.example/','//evil.example/','/dashboard/requests/../settings','/dashboard/requests/%2f%2fevil','/dashboard/api/v1/connection'])('rejects unsafe notification target %s',async(url)=>{
  const s=setup();await s.invoke('push',{data:{json:()=>({title:'Private title',url})}});expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor reminder',expect.objectContaining({data:{url:'/dashboard/'}}));
  await s.invoke('notificationclick',{notification:{close:vi.fn(),data:{url}}});expect(s.openWindow).toHaveBeenCalledWith('/dashboard/');
});

it('shows email-volume alerts and opens only the exact Settings route', async () => {
  const s=setup();
  await s.invoke('push',{data:{json:()=>({title:'Fridgedoor: unusual email processing',url:'/dashboard/settings/email',tag:'volume'})}});
  expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor: unusual email processing',expect.objectContaining({data:{url:'/dashboard/settings/email'}}));
  await s.invoke('notificationclick',{notification:{close:vi.fn(),data:{url:'/dashboard/settings'}}});
  expect(s.openWindow).toHaveBeenCalledWith('/dashboard/settings');
  await s.invoke('notificationclick',{notification:{close:vi.fn(),data:{url:'/dashboard/settings/email'}}});
  expect(s.openWindow).toHaveBeenCalledWith('/dashboard/settings/email');
  await s.invoke('notificationclick',{notification:{close:vi.fn(),data:{url:'/dashboard/settings/../../evil'}}});
  expect(s.openWindow).toHaveBeenLastCalledWith('/dashboard/');
});

it.each([
  '1 calendar suggestion and 1 list item are ready for review.',
  '2 calendar suggestions and 3 list items and 1 saved fact update are ready for review.',
  '1 household suggestion is ready for review.',
])('preserves grouped review body: %s', async (body) => {
  const s = setup();
  await s.invoke('push', { data: { json: () => ({ title: 'Fridgedoor review', body, url: '/dashboard/' }) } });
  expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor review', expect.objectContaining({ body }));
});

it('rejects private text appended to an otherwise valid grouped body', async () => {
  const s = setup();
  await s.invoke('push', { data: { json: () => ({ title: 'Fridgedoor review', body: '1 calendar suggestion and 1 list item are ready for review. Private email', url: '/dashboard/' }) } });
  expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor review', expect.objectContaining({ body: 'Review Home for a household update.' }));
});

it('opens the private trial with fixed invitation text', async () => {
  const s=setup();
  await s.invoke('push',{data:{json:()=>({title:'Fridgedoor feedback trial',url:'/dashboard/requests/feedback-trial'})}});
  expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor feedback trial',expect.objectContaining({body:'Rate your recent suggestions: Useful or Not useful. No explanation needed.',data:{url:'/dashboard/requests/feedback-trial'}}));
});

it('shows a fixed deadline interruption without revealing the underlying content',async()=>{
  const s=setup();
  await s.invoke('push',{data:{json:()=>({title:'Fridgedoor needs attention',body:'A planner deadline needs attention before your next morning review.',url:'/dashboard/plans/synthetic'})}});
  expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor needs attention',expect.objectContaining({body:'A planner deadline needs attention before your next morning review.'}));
});
it.each([
  'Household coordination needs an answer before your next morning review.',
  'A change to household plans needs attention before your next morning review.',
  'An unresolved household decision needs attention before your next morning review.',
])('preserves source-backed attention category copy: %s',async body=>{
  const s=setup();await s.invoke('push',{data:{json:()=>({title:'Fridgedoor needs attention',body,url:'/dashboard/plans/synthetic'})}});
  expect(s.showNotification).toHaveBeenCalledWith('Fridgedoor needs attention',expect.objectContaining({body}));
});
