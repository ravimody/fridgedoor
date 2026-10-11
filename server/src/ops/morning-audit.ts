import Database from 'better-sqlite3';
import {DateTime} from 'luxon';
import {loadConfig} from '../config.js';
import {keyFromSecret} from '../crypto.js';
import {DailyOverviewService} from '../services/daily-overview.js';
// Operational read-only check. Provider acceptance is not proof of phone display.
export function auditMorning(db:Database.Database,key:Buffer,now=new Date()) {
  const owners=db.prepare(`SELECT m.id,m.household_id,m.timezone,d.local_time FROM members m
    JOIN digest_settings d ON d.member_id=m.id AND d.enabled=1 WHERE m.active=1`).all() as Array<{id:string;household_id:string;timezone:string;local_time:string}>;
  return owners.map(owner=>{
    const local=DateTime.fromJSDate(now).setZone(owner.timezone),date=local.toISODate()!;
    const due=DateTime.fromISO(`${date}T${owner.local_time}`,{zone:owner.timezone});
    if(local<due)return {date,status:'not_due' as const};
    const service=new DailyOverviewService(db,key,undefined,'audit',()=>now),actor={memberId:owner.id,householdId:owner.household_id};
    const ai=service.settings(actor).enabled;
    const review=ai?service.read(actor):null;
    const devices=(db.prepare("SELECT count(*) n FROM push_subscriptions WHERE member_id=? AND status='enabled'").get(owner.id) as {n:number}).n;
    const accepted=(db.prepare("SELECT count(*) n FROM digest_deliveries dd JOIN push_subscriptions ps ON ps.id=dd.subscription_id AND ps.status='enabled' WHERE dd.member_id=? AND dd.local_date=? AND dd.state='accepted'").get(owner.id,date) as {n:number}).n;
    const calendar=review?.coverage.find(channel=>channel.channel==='calendar')?.status;
    const healthy=(!ai || review?.state==='ready') && devices>0 && accepted>=devices && !['unavailable','stale','truncated'].includes(calendar??'');
    return {date,status:healthy?'passed' as const:'needs_attention' as const,review:review?.state??'ai_disabled',calendar:calendar??'not_checked',devices,providerAccepted:accepted};
  });
}
if(process.argv[1]?.endsWith('/morning-audit.js') || process.argv[1]?.endsWith('/morning-audit.ts')) {
  try {
    const config=loadConfig(),db=new Database(config.DATABASE_PATH,{readonly:true});
    const checks=auditMorning(db,keyFromSecret(config.SESSION_SECRET));db.close();
    console.log(JSON.stringify({checkedAt:new Date().toISOString(),checks,phoneDisplay:'requires member confirmation'}));
    if(checks.some(check=>check.status==='needs_attention'))process.exitCode=1;
  } catch {console.error('MORNING_AUDIT_FAILED');process.exitCode=1;}
}
