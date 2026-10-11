// Operator-only: node dist/ai/replay-relevance-cli.js <member-id>
import Database from 'better-sqlite3';
import {loadConfig} from '../config.js';
import {keyFromSecret} from '../crypto.js';
import {RelevanceTrialService} from '../services/relevance-trial.js';
import {PlanRepository} from '../repos/plans.js';
import {replayRelevance} from './relevance-replay.js';
import {LlmHub} from '../llm/hub.js';
import {resolveAiConfig,SettingsStore} from '../settings.js';
const config=loadConfig(),db=new Database(config.DATABASE_PATH,{readonly:true});
try {
  const member=db.prepare('SELECT id,household_id,timezone FROM members WHERE id=? AND active=1').get(process.argv[2]??'') as {id:string;household_id:string;timezone:string}|undefined;
  if(!member)throw new Error('MEMBER_NOT_FOUND');
  const key=keyFromSecret(config.SESSION_SECRET),actor={memberId:member.id,householdId:member.household_id};
  const items=new RelevanceTrialService(db,key).list(actor).items;
  const repo=new PlanRepository(db,key);
  const input=items.map(({id,facts,observedAt})=>{
    const row=db.prepare('SELECT plan_id FROM relevance_trial_items WHERE id=? AND owner_id=?').get(id,member.id) as {plan_id:string|null};
    let source:{sender:string|null;text:string}|undefined;
    try {const evidence=repo.evidence(row.plan_id!,member.id);if(evidence.availability==='available')source={sender:evidence.sender??null,text:evidence.text.slice(0,6000)};}catch { /* Missing source remains explicit absence, never another owner's source. */ }
    return {id,facts,observedAt,timezone:member.timezone,...(source?{source}:{})};
  });
  if(config.AI_ENABLED==='false')throw new Error('AI_UNAVAILABLE');
  const result=await replayRelevance(new LlmHub(()=>resolveAiConfig(config,new SettingsStore(db,config.SESSION_SECRET))),input);
  console.log(JSON.stringify({examples:items.length,withSource:input.filter(i=>i.source).length,results:result.items.map(({id,...result})=>{const original=items.find(item=>item.id===id)!;return{title:original.facts.title,vote:original.value,...result};})}));
} catch(error) {
  const code=error instanceof Error && ['MEMBER_NOT_FOUND','AI_UNAVAILABLE','REPLAY_INVALID_INPUT','REPLAY_UNAVAILABLE','REPLAY_INVALID_IDS'].includes(error.message)?error.message:'REPLAY_FAILED';
  console.error(code);process.exitCode=1;
} finally {db.close();}
