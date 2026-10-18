import { expect, it, vi } from 'vitest';
import { LlmHub } from '../llm/hub.js';
import { createTrialSummaryProvider } from './relevance-summary.js';
const reply = (text: string, status = 'completed') => Response.json({ id: 'resp', status, model: 'synthetic-model', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
it('uses configured model, bounded non-stored structured output and only supplied feedback',async()=>{
  const result={overview:'Tentative preference',preferences:[{direction:'avoid',pattern:'Routine arrivals may be noise.',evidenceIds:['synthetic-id']}]};
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(reply(JSON.stringify(result))).mockResolvedValueOnce(reply('{}','incomplete'));
  const provider=createTrialSummaryProvider(new LlmHub(()=>({provider:'openai',apiKey:'synthetic-key',models:{main:'synthetic-model'}}),{fetch:request}),{})()!;
  const input=[{id:'synthetic-id',title:'Synthetic arrival',notes:'',vote:'not_useful',reason:''}];
  expect(await provider.summarize(input)).toEqual(result);
  const body=JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({model:'synthetic-model',store:false,max_output_tokens:2500});
  expect(JSON.parse(body.input[0].content[0].text)).toEqual({examples:input,previous:[]});
  expect(body.tools).toBeUndefined();
  await expect(provider.summarize(input)).rejects.toThrow('SUMMARY_UNAVAILABLE');
});
it('is unavailable without a configured model or with AI switched off',()=>{
  const hub=new LlmHub(()=>({provider:'openai',apiKey:'k',models:{main:'m'}}));
  expect(createTrialSummaryProvider(new LlmHub(()=>undefined),{})()).toBeUndefined();
  expect(createTrialSummaryProvider(hub,{AI_ENABLED:'false'})()).toBeUndefined();
  expect(createTrialSummaryProvider(hub,{})()).toBeDefined();
});
