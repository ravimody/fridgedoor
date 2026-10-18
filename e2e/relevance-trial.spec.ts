import { test, expect } from '@playwright/test';
test('phone push link opens trial, saves quick ratings and retains them after reload', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  const items=[{id:'sample-1',facts:{title:'Synthetic package arrival',category:'other',participants:[],preparationTasks:[],unresolvedFields:[]},observedAt:'2026-09-19T12:00:00Z',value:null as string|null,reason:'',revision:1}];
  const writes:string[]=[];let learning={enabled:false,revision:0,preferences:[],generatedAt:null};
  await page.route('**/dashboard/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/v1')[1]!;
    if(path==='/relevance-trial/learning' && route.request().method()==='POST') learning={...learning,enabled:route.request().postDataJSON().enabled,revision:learning.revision+1};
    if(path==='/relevance-trial/sample-1' && route.request().method()==='POST') { const body=route.request().postDataJSON();writes.push(path);items[0]={...items[0]!,value:body.value,reason:body.reason,revision:2}; }
    const data=path==='/session'?{member:{id:'fixture',householdId:'h',displayName:'Fixture',timezone:'America/New_York'},csrfToken:'synthetic-session-token-for-trial-test'}:path==='/relevance-trial/learning'?learning:path==='/relevance-trial/summary'?null:path.startsWith('/relevance-trial')?{items,expiresAt:'2026-10-19T12:00:00Z'}:path==='/daily-overview'?{state:'fallback',result:{summary:'',items:[],questions:[],omittedRefs:[]},items:[],generatedAt:null,coverage:[],revision:1}:path==='/assistant/settings'?{enabled:false,consent:false}:[];
    await route.fulfill({json:{data}});
  });
  await page.goto('/dashboard/requests/feedback-trial');
  await expect(page.getByRole('heading',{name:'Teach suggestions',level:1})).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/relevance-trial$/);
  await expect(page.getByRole('heading',{name:'Synthetic package arrival'})).toBeVisible();
  await page.getByRole('button',{name:'Turn on nightly learning'}).click();
  await expect(page.getByRole('button',{name:'Pause nightly learning'})).toBeVisible();
  await page.getByRole('button',{name:'Not useful',exact:true}).click();
  await expect(page.getByText('1 of 1 answered')).toBeVisible();
  await page.reload();
  await expect(page.getByText('1 of 1 answered')).toBeVisible();
  await page.getByRole('button',{name:'Change answer'}).click();
  await page.getByText('Add a reason (optional)').click();
  await page.getByLabel('What should we learn?').fill('Only delivery problems matter');
  await page.getByRole('button',{name:'Useful',exact:true}).click();
  await expect(page.getByText('Thanks, your ratings are saved.')).toBeVisible();
  expect(items[0]!.reason).toBe('Only delivery problems matter');
  expect(writes).toEqual(['/relevance-trial/sample-1','/relevance-trial/sample-1']);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});
