import {expect,it,vi} from 'vitest';
import {LlmHub} from '../llm/hub.js';
import {replayRelevance} from './relevance-replay.js';
const reply=(value:unknown)=>Response.json({id:'resp',status:'completed',model:'synthetic',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
it('evaluates only supplied evidence and rejects missing or invented IDs',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(reply({items:[{id:'sample',destination:'coming_up',push:false,reason:'Personal invitation'}]})).mockResolvedValueOnce(reply({items:[]}));
  const hub=new LlmHub(()=>({provider:'openai',apiKey:'synthetic-key',models:{main:'synthetic'}}),{fetch:request});
  const input=[{id:'sample',facts:{title:'Synthetic invitation',category:'optional',participants:[],preparationTasks:[],unresolvedFields:[]},observedAt:'2026-09-19T12:00:00Z'}];
  expect((await replayRelevance(hub,input)).items[0]!.push).toBe(false);
  const body=JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({store:false,model:'synthetic'});expect(body.input[0].content[0].text).toContain('"id":"sample"');
  await expect(replayRelevance(hub,input)).rejects.toThrow('REPLAY_INVALID_IDS');
  await expect(replayRelevance(new LlmHub(()=>undefined),input)).rejects.toThrow('AI_UNAVAILABLE');
});
