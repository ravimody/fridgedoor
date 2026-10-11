import { expect, it, vi } from 'vitest';
import { OpenAiResponsesProvider } from '../llm/openai.js';
import { ReviewedEmailProvider, auditEmail } from './reviewed-email.js';
import type { AiProvider, ExtractionPacket } from './ai-contracts.js';
const packet: ExtractionPacket = {schemaVersion:'extract-v1',sourceVersionId:'source',timezone:'America/New_York',ownerLabel:'Owner',allowedParticipants:['Owner'],allowedCategories:['other'],text:'Synthetic body',truncated:false,personalPreferences:[{direction:'avoid',pattern:'Routine delivery confirmations'}]};
const skipped = {decision:'exclude' as const, category:'other' as const, confidence:1, uncertaintyReasons:[],privacyFlags:[],candidates:[]};
// The `email` model (luna) screens each message; the stronger `review` model (sol) extracts what passes.
function setup(decision='skip',confidence='high') {
 const fetchMock=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({id:'gate-id',object:'response',model:'luna-2026',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({decision,confidence,reason:'Synthetic rationale'}),annotations:[]}]}],usage:{input_tokens:100,output_tokens:50,output_tokens_details:{reasoning_tokens:20}}}),{headers:{'content-type':'application/json'}}));
 const extract=vi.fn().mockResolvedValue({model:'sol',provider:'openai',result:skipped,usage:{inputTokens:200,outputTokens:100,providerRequestId:'review-id'}});
 const extractor={extract,respondToChat:async()=>{throw Error('UNUSED');}} satisfies AiProvider;
 const gate=new OpenAiResponsesProvider({apiKey:'synthetic',fetch:fetchMock as unknown as typeof fetch});
 return {provider:new ReviewedEmailProvider(gate,'luna',extractor,'sol'),fetchMock,extract};
}
const audited=Array.from({length:100},(_,i)=>String(i)).find(auditEmail)!;
const unAudited=Array.from({length:100},(_,i)=>String(i)).find(id=>!auditEmail(id))!;
it('reads the body with high reasoning and private preferences; skips clear noise without a second request',async()=>{
 const {provider,fetchMock,extract}=setup();const before=vi.fn();
 const result=await provider.extract({...packet,sourceVersionId:unAudited},new AbortController().signal,before);
 const request=JSON.parse(fetchMock.mock.calls[0]![1].body);
 expect(request).toMatchObject({store:false,reasoning:{effort:'high'}});expect(request.tools).toBeUndefined();
 expect(JSON.parse(request.input[0].content[0].text)).toMatchObject({text:packet.text,personalPreferences:packet.personalPreferences});
 expect(extract).not.toHaveBeenCalled();expect(before).toHaveBeenCalledExactlyOnceWith('luna');expect(result.result).toEqual(skipped);
});
it.each([['review','high'],['uncertain','high'],['skip','medium']])('reviews %s/%s independently and accounts for both models',async(decision,confidence)=>{
 const {provider,extract}=setup(decision,confidence);const before=vi.fn();const signal=new AbortController().signal;
 const value=await provider.extract(packet,signal,before);
 expect(before).toHaveBeenCalledWith('sol');expect(extract).toHaveBeenCalledWith(packet,signal);
 expect(value.usage).toMatchObject({inputTokens:300,outputTokens:150,stages:[{model:'luna',reasoningTokens:20,providerRequestId:'gate-id'},{model:'sol'}]});
 expect(value.model).toBe('luna');
});
it('audits confident skips deterministically',async()=>{
 const {provider,extract}=setup();const value=await provider.extract({...packet,sourceVersionId:audited},new AbortController().signal);
 expect(value.usage.reviewReason).toBe('skip_audit');expect(extract).toHaveBeenCalledOnce();
});
it.each([{truncated:true},{media:[{kind:'image' as const,mimeType:'image/png' as const,dataBase64:'cG5n'}]}])('never silently drops incomplete or attached sources',async(extra)=>{
 const {provider,extract}=setup();await provider.extract({...packet,sourceVersionId:unAudited,...extra},new AbortController().signal);expect(extract).toHaveBeenCalledOnce();
});
it('does not publish unreviewed results when authorization/capacity fails',async()=>{
 const {provider,extract}=setup('review');await expect(provider.extract(packet,new AbortController().signal,model=>{if(model==='sol')throw Error('AI_REVIEW_CAPACITY');})).rejects.toThrow('AI_REVIEW_CAPACITY');expect(extract).not.toHaveBeenCalled();
});
it('does not fall back to Luna when stronger review fails',async()=>{
 const {provider,extract}=setup('review');extract.mockRejectedValueOnce(Error('AI_RETRYABLE'));await expect(provider.extract(packet,new AbortController().signal)).rejects.toThrow('AI_RETRYABLE');
});

it('resumes a saved gate after capacity waits without paying for Luna again',async()=>{
 const {provider,fetchMock,extract}=setup('review');
 const values=new Map<string,import('./ai-contracts.js').EmailGateCheckpoint>();
 const store={load:(key:string)=>values.get(key),save:(key:string,value:import('./ai-contracts.js').EmailGateCheckpoint)=>{values.set(key,value);}};
 const blocked=vi.fn((model:string)=>{if(model==='sol')throw Error('AI_REVIEW_CAPACITY');});
 for(let i=0;i<4;i++)await expect(provider.extract(packet,new AbortController().signal,blocked,store)).rejects.toThrow('AI_REVIEW_CAPACITY');
 expect(fetchMock).toHaveBeenCalledOnce();expect(extract).not.toHaveBeenCalled();
 const reserve=vi.fn();await provider.extract(packet,new AbortController().signal,reserve,store);
 expect(reserve).toHaveBeenCalledExactlyOnceWith('sol');expect(extract).toHaveBeenCalledOnce();expect(fetchMock).toHaveBeenCalledOnce();
 await provider.extract({...packet,personalPreferences:[]},new AbortController().signal,reserve,store);
 expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('maps gate failures to stable codes and checks the extraction model',async()=>{
 const {extract}=setup('review');const extractor={extract,respondToChat:async()=>{throw Error('UNUSED');}};
 const gate=(status:number)=>new OpenAiResponsesProvider({apiKey:'synthetic',fetch:(async()=>Response.json({error:{message:'PRIVATE'}},{status})) as unknown as typeof fetch});
 await expect(new ReviewedEmailProvider(gate(429),'luna',extractor,'sol').extract(packet,new AbortController().signal)).rejects.toThrow(/^AI_RETRYABLE$/);
 await expect(new ReviewedEmailProvider(gate(401),'luna',extractor,'sol').extract(packet,new AbortController().signal)).rejects.toThrow(/^AI_PROVIDER_FAILED$/);
 expect(extract).not.toHaveBeenCalled();
 const mismatched=setup('review');mismatched.extract.mockResolvedValueOnce({model:'other-model',provider:'openai',result:skipped,usage:{}});
 await expect(mismatched.provider.extract(packet,new AbortController().signal)).rejects.toThrow('AI_MODEL_MISMATCH');
});
