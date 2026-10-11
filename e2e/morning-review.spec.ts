import {test,expect} from '@playwright/test';
test('phone morning review groups items and dismisses one without changing plans',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let items=[['today','Bring costume'],['prepare','Lunch tomorrow'],['decision','Choose pickup person']].map(([category,title],i)=>({refs:[`candidate-${i}`],category,title,headline:title,detail:'Synthetic planning context',priority:'routine',normalizedTime:null,sourceRefs:[],href:null}));
  const writes:string[]=[];
  await page.route('**/dashboard/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/v1')[1]!;
    if(route.request().method()==='POST' && path==='/daily-overview/dismiss') {writes.push(path);const refs=route.request().postDataJSON().refs;items=items.filter(item=>!refs.includes(item.refs[0]));}
    const data=path==='/session'?{member:{id:'fixture',householdId:'h',displayName:'Fixture',timezone:'America/New_York'},csrfToken:'synthetic-session-token-for-test'}:path.startsWith('/daily-overview')?{state:'ready',result:{summary:'Your morning review',items:[],questions:[],omittedRefs:[]},items,generatedAt:null,coverage:[],revision:1}:path==='/daily-ai-settings'?{enabled:true,revision:1}:path==='/assistant/settings'?{enabled:false,consent:false}:[];
    await route.fulfill({json:{data}});
  });
  await page.goto('/dashboard/');
  const review=page.locator('.daily-overview');
  for(const name of ['Today’s rhythm','On the horizon','Needs your attention'])await expect(review.getByRole('heading',{name,exact:true})).toBeVisible();
  await review.getByLabel('Options for Lunch tomorrow').click();
  await review.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect(review.getByText('Lunch tomorrow')).toHaveCount(0);
  await page.reload();await expect(review.getByText('Bring costume')).toBeVisible();
  await expect(review.getByText('Lunch tomorrow')).toHaveCount(0);
  expect(writes).toEqual(['/daily-overview/dismiss']);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

for(const fails of [false,true])test(`dismiss updates immediately during a slow save and ${fails?'restores on failure':'stays dismissed after success'}`,async({page})=>{
  const item={refs:['candidate-slow'],category:'today',title:'Slow-save appointment',headline:'Appointment',detail:'Synthetic',priority:'routine',normalizedTime:null,sourceRefs:[],href:null};
  let saved=false;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/dashboard/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/v1')[1]!;
    if(path==='/daily-overview/dismiss'){
      await gate;
      if(fails){await route.fulfill({status:503,json:{error:{code:'UNAVAILABLE'}}});return;}
      saved=true;
    }
    const data=path==='/session'?{member:{id:'fixture',householdId:'h',displayName:'Fixture',timezone:'America/New_York'},csrfToken:'synthetic-session-token-for-test'}:path.startsWith('/daily-overview')?{state:'ready',result:{summary:'Morning review',items:[],questions:[],omittedRefs:[]},items:saved?[]:[item],generatedAt:null,coverage:[],revision:1}:path==='/daily-ai-settings'?{enabled:true,revision:1}:path==='/assistant/settings'?{enabled:false,consent:false}:[];
    await route.fulfill({json:{data}});
  });
  await page.goto('/dashboard/');
  const review=page.locator('.daily-overview');
  await review.getByLabel('Options for Slow-save appointment').click();
  await review.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect(review.getByText(item.title)).toHaveCount(0,{timeout:500});
  // A normal poll must not resurrect the item while its write is still pending.
  await page.waitForTimeout(3200);
  await expect(review.getByText(item.title)).toHaveCount(0);
  release();
  if(fails){await expect(review.getByText(item.title)).toBeVisible();await expect(page.getByRole('status').filter({hasText:'It has been restored'})).toBeVisible();}
  else {await expect.poll(()=>saved).toBe(true);await page.reload();await expect(review.getByText(item.title)).toHaveCount(0);}
});

test('Linen & Teal supports device appearance, day navigation, swipe and durable Undo',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.clock.setFixedTime(new Date('2026-09-19T11:00:00Z'));
  const item={refs:['candidate-ui'],category:'prepare',title:'Pack for tomorrow',headline:'Pack',detail:'Bring the completed form.',priority:'routine',normalizedTime:null,sourceRefs:[],href:null};let dismissed=false;const writes:string[]=[];
  await page.route('**/dashboard/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/v1')[1]!;
    if(path==='/daily-overview/dismiss'){dismissed=true;writes.push(path);}if(path==='/daily-overview/restore'){dismissed=false;writes.push(path);}
    const data=path==='/session'?{member:{id:'fixture',householdId:'h',displayName:'Fixture',timezone:'America/New_York'},csrfToken:'synthetic-session-token-for-test'}:path.startsWith('/daily-overview')?{state:'ready',result:{summary:'Prepare for tomorrow.',items:[],questions:[],omittedRefs:[]},items:[{...item,refs:['candidate-decision'],category:'decision',title:'Confirm pickup person',detail:'Pickup coverage still needs confirmation.',priority:'important'},...(dismissed?[]:[item])],generatedAt:null,coverage:[],revision:1,...(path.endsWith('/dismiss')?{undoToken:'synthetic-receipt'}:{})}:path==='/daily-ai-settings'?{enabled:true,revision:1}:path==='/agenda'?{items:[{id:'today',title:'School pickup',time:{kind:'timed',start:'2026-09-19T15:00:00-04:00',end:'2026-09-19T15:30:00-04:00',timezone:'America/New_York'},status:'confirmed',origin:'Calendar'},{id:'tomorrow',title:'Tomorrow appointment',time:{kind:'all_day',startDate:'2026-09-20',endDateExclusive:'2026-09-21'},status:'confirmed',origin:'Calendar'}]}:path==='/plans'?{plans:[]}:path==='/reminders'?{reminders:[]}:path.startsWith('/lists/')?{items:[]}:path==='/assistant/settings'?{enabled:false,consent:false}:[];
    await route.fulfill({json:{data}});
  });
  await page.goto('/dashboard/');
  const suggestion=page.locator('.review-swipe').filter({hasText:'Pack for tomorrow'});await expect(suggestion).toBeVisible();
  await suggestion.evaluate(element=>element.scrollIntoView({block:'center'}));
  const box=(await suggestion.boundingBox())!;await page.mouse.move(box.x+140,box.y+25);await page.mouse.down();await page.mouse.move(box.x+5,box.y+25,{steps:8});await page.mouse.up();
  await expect(suggestion).toHaveCount(0);await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(suggestion).toBeVisible();await page.reload();await expect(suggestion).toBeVisible();
  await page.getByRole('button',{name:'Sunday, September 20'}).click();await expect(page.getByText('Tomorrow appointment')).toBeVisible();await expect(page.getByText('Pack for tomorrow')).toHaveCount(0);
  await page.getByRole('link',{name:'More',exact:true}).click();await page.getByLabel('Appearance').selectOption('dark');await page.reload();await expect(page.getByLabel('Appearance')).toHaveValue('dark');
  await page.getByRole('link',{name:'Home',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-appearance','dark');await expect(page.locator('.day-picker')).toBeVisible();await page.screenshot({path:'/tmp/planner-linen-dark.png',fullPage:true});
  await page.getByRole('link',{name:'More',exact:true}).click();await page.getByLabel('Appearance').selectOption('system');await page.emulateMedia({colorScheme:'light'});const light=await page.locator('body').evaluate(e=>getComputedStyle(e).color);await page.emulateMedia({colorScheme:'dark'});expect(await page.locator('body').evaluate(e=>getComputedStyle(e).color)).not.toBe(light);
  await page.getByLabel('Appearance').selectOption('light');await page.getByRole('link',{name:'Home',exact:true}).click();await expect(page.locator('.day-picker')).toBeVisible();await page.screenshot({path:'/tmp/planner-linen-light.png',fullPage:true});
  await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(writes).toEqual(['/daily-overview/dismiss','/daily-overview/restore']);
});
