import {test,expect} from '@playwright/test';
test.use({viewport:{width:390,height:844}});
test('phone todo snooze moves the date and remains in the list',async({page})=>{
 let task={id:'task',kind:'todo',title:'Reply about workshop timing',completedAt:null,revision:1,createdAt:'2026-09-20T12:00:00Z',dueTime:'2026-09-21',snoozedUntil:undefined as string|undefined};
 await page.route('**/dashboard/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.split('/v1')[1]!;
  if(path==='/list-items/task/snooze'){const body=route.request().postDataJSON();task={...task,dueTime:body.date,snoozedUntil:body.date,revision:2};}
  const data=path==='/session'?{member:{id:'fixture',householdId:'household',displayName:'Fixture',timezone:'America/New_York'},csrfToken:'synthetic-session-token-for-phone-test'}:path==='/lists/todo'?{items:[task]}:path==='/list-items/task/snooze'?task:path==='/plans'?{plans:[]}:path==='/reminders'?{reminders:[]}:path==='/connection'?{status:'active'}:path==='/daily-ai-settings'?{enabled:false,revision:0}:path==='/daily-overview'?{state:'unavailable',result:{summary:'',items:[],questions:[],omittedRefs:[]},items:[],coverage:[],revision:0}:path==='/agenda'?{items:[]}:[];
  await route.fulfill({json:{data}});
 });
 await page.goto('/dashboard/todos');
 await expect(page.getByText('Reply about workshop timing')).toBeVisible();
 await page.getByText('Later',{exact:true}).click();
 await expect(page.getByRole('button',{name:'Tomorrow',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'In 3 days',exact:true})).toBeVisible();
 await page.screenshot({path:'test-results/todo-snooze-light.png',fullPage:true});
 await page.emulateMedia({colorScheme:'dark'});
 await page.screenshot({path:'test-results/todo-snooze-dark.png',fullPage:true});
 await page.getByRole('button',{name:'In 7 days',exact:true}).click();
 await expect(page.getByText(/^Remind on/)).toBeVisible();
 await expect(page.getByText('Reply about workshop timing')).toBeVisible();
 expect(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth)).toBe(true);
});

for(const kind of ['grocery','todo'] as const) test(`${kind} completion moves into a collapsed history and can be reopened`,async({page})=>{
 let item={id:'item',kind,title:kind==='grocery'?'Milk':'Call school',completedAt:null as string|null,revision:1,createdAt:'2026-09-20T12:00:00Z'};
 await page.route('**/dashboard/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname.split('/v1')[1]!;
  if(path==='/list-items/item' && route.request().method()==='PATCH'){const body=route.request().postDataJSON();item={...item,completedAt:body.completed?'2026-09-20T14:30:00Z':null,revision:item.revision+1};}
  const data=path==='/session'?{member:{id:'fixture',householdId:'household',displayName:'Fixture',timezone:'America/New_York'},csrfToken:'synthetic-session-token-for-phone-test'}:path===`/lists/${kind}`?{items:[item]}:path.startsWith('/lists/')?{items:[]}:path==='/list-items/item'?item:path==='/plans'?{plans:[]}:path==='/reminders'?{reminders:[]}:path==='/connection'?{status:'active'}:path==='/daily-ai-settings'?{enabled:false,revision:0}:path==='/daily-overview'?{state:'unavailable',result:{summary:'',items:[],questions:[],omittedRefs:[]},items:[],coverage:[],revision:0}:path==='/agenda'?{items:[]}:[];
  await route.fulfill({json:{data}});
 });
 await page.goto(`/dashboard/${kind==='grocery'?'groceries':'todos'}`);
 const active=page.getByRole('region',{name:'Active items'});
 await expect(active.getByText(item.title,{exact:true})).toBeVisible();
 await (kind==='grocery'?active.getByRole('checkbox'):active.getByRole('button',{name:'Done',exact:true})).click();
 await expect(active.getByText(item.title,{exact:true})).toHaveCount(0);
 const completed=page.locator('.completed-list');await expect(completed).not.toHaveAttribute('open');
 await completed.locator('summary').click();await expect(completed.getByText('Completed Sep 20, 2026 · 10:30 AM')).toBeVisible();
 await page.screenshot({path:`test-results/${kind}-completed-light.png`,fullPage:true});
 await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:`test-results/${kind}-completed-dark.png`,fullPage:true});
 expect(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth)).toBe(true);
 await completed.getByRole('button',{name:`Reopen ${item.title}`}).click();await expect(active.getByText(item.title,{exact:true})).toBeVisible();
 await page.reload();await expect(active.getByText(item.title,{exact:true})).toBeVisible();
});
