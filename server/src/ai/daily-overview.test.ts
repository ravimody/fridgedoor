import {expect,it,vi} from 'vitest';
import {LlmDailyOverviewProvider, timingAtReview, categoryFor} from './daily-overview.js';
import {LlmHub} from '../llm/hub.js';
const create=vi.fn<typeof fetch>();
const reply=(value:unknown)=>Response.json({status:'completed',model:'synthetic',id:'synthetic',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const sent=(index=0)=>JSON.parse(create.mock.calls[index]![1]!.body as string);
const hub=new LlmHub(()=>({provider:'openai',apiKey:'synthetic',models:{main:'synthetic'}}),{fetch:create});
import type {DailyContext} from '../services/daily-context.js';
it('constrains every output reference to authorized candidates and skips empty input',async()=>{
  const context={candidates:[]} as unknown as DailyContext;
  const provider=new LlmDailyOverviewProvider(hub);
  expect((await provider.generate(context,new AbortController().signal)).result).toMatchObject({items:[]});
  expect(create).not.toHaveBeenCalled();
  context.candidates=[{ref:'authorized-1'} as DailyContext['candidates'][number],{ref:'authorized-2'} as DailyContext['candidates'][number]];
  create.mockResolvedValue(reply({summary:'Review',commitments:{},items:[],questions:[],omittedRefs:[]}));
  await provider.generate(context,new AbortController().signal);
  const schema=sent().text.format.schema;
  const resolve=(node:typeof schema):typeof schema=>node.$ref?resolve(node.$ref.slice(2).split('/').reduce((value:typeof schema,key:string)=>value[key],schema)):node;
  for(const field of ['items','questions'])expect(resolve(resolve(resolve(schema.properties[field].items).properties.refs).items).enum).toEqual(['authorized-1','authorized-2']);
  expect(resolve(resolve(schema.properties.omittedRefs.items).properties.ref).enum).toEqual(['authorized-1','authorized-2']);
});


it('requires separate AI annotations for every commitment, even beyond eight items', async () => {
  create.mockReset();
  const candidates = Array.from({length:10}, (_, index) => ({ref:'required-'+index, required:true, title:'Appointment '+index, kind:'calendar', normalizedTime:{kind:'all_day',startDate:'2026-09-19',endDateExclusive:'2026-09-20'}}));
  const context = {referenceDate:'2026-09-19', timezone:'America/New_York', candidates} as unknown as DailyContext;
  const commitments = Object.fromEntries(candidates.map(c => [c.ref,{headline:c.title,detail:'On your calendar today.'}]));
  create.mockResolvedValueOnce(reply({summary:'Ten commitments today',commitments,items:[],questions:[],omittedRefs:[]}));
  const provider = new LlmDailyOverviewProvider(hub);
  const response = await provider.generate(context,new AbortController().signal);
  expect(response.result).toMatchObject({items:candidates.map(c=>({refs:[c.ref],headline:c.title,category:'today',priority:'important'}))});
  const schema = sent().text.format.schema;
  expect(schema.properties.commitments.required).toEqual(candidates.map(c=>c.ref));
  expect(schema.properties.items.maxItems).toBe(0);
  delete commitments['required-0'];
  create.mockResolvedValueOnce(reply({summary:'Missing one',commitments,items:[],questions:[],omittedRefs:[]}));
  await expect(provider.generate(context,new AbortController().signal)).rejects.toMatchObject({code:'AI_MALFORMED_OUTPUT'});
});


it('provides explicit timing facts for morning, afternoon, and TBD entries', () => {
  const candidate={title:'Lunch',normalizedTime:{kind:'timed',start:'2026-09-20T12:00:00-04:00',end:'2026-09-20T13:00:00-04:00',timezone:'America/New_York'}} as DailyContext['candidates'][number];
  const context={referenceDate:'2026-09-20',referenceTime:'2026-09-20T11:00:00Z'};
  expect(timingAtReview(candidate,context)).toBe('not_started');
  expect(timingAtReview(candidate,{...context,referenceTime:'2026-09-20T16:30:00Z'})).toBe('in_progress');
  expect(timingAtReview(candidate,{...context,referenceTime:'2026-09-20T18:00:00Z'})).toBe('ended');
  expect(timingAtReview({...candidate,title:'Lunch, time TBD'},{...context,referenceTime:'2026-09-20T18:00:00Z'})).toBe('uncertain');
});


it('keeps overnight and multi-day calendar commitments in Today', () => {
  const context={referenceDate:'2026-09-20',timezone:'America/New_York'} as DailyContext;
  const candidate={kind:'calendar',normalizedTime:{kind:'all_day',startDate:'2026-09-19',endDateExclusive:'2026-09-21'}} as DailyContext['candidates'][number];
  expect(categoryFor(candidate,context)).toBe('today');
  expect(categoryFor({...candidate,normalizedTime:{kind:'timed',start:'2026-09-19T23:00:00-04:00',end:'2026-09-20T01:00:00-04:00',timezone:'America/New_York'}},context)).toBe('today');
});
