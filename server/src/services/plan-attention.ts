import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { encryptJson } from '../crypto.js';
import type { ExtractionResult } from '../providers/ai-contracts.js';
import { PlanRepository } from '../repos/plans.js';
/** When a candidate's time begins, or undefined when it has no usable time. */
function startsAt(time: ExtractionResult['candidates'][number]['safeFacts']['time'], timezone: string): number | undefined {
  if (!time) return undefined;
  if (time.kind === 'timed') return Date.parse(time.start);
  if (time.kind === 'deadline') return Date.parse(time.at);
  if (time.kind === 'all_day') return DateTime.fromISO(time.startDate, { zone: timezone }).toMillis();
  return undefined;
}

export function nextMorningReview(db: Database.Database, ownerId: string, timezone: string, now: Date) {
  const setting=db.prepare('SELECT local_time FROM digest_settings WHERE member_id=?').get(ownerId) as {local_time:string}|undefined;
  const local=DateTime.fromJSDate(now).setZone(timezone);
  let next=DateTime.fromISO(`${local.toISODate()}T${setting?.local_time??'07:00'}`,{zone:timezone});
  if(next<=local) next=next.plus({days:1});
  return next.toUTC().toISO()!;
}
export class PlanAttentionService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock:()=>Date=()=>new Date()) {}
  record(input:{ownerId:string;planId:string;sourceVersionId:string;candidate:ExtractionResult['candidates'][number]}) {
    const attention=input.candidate.attention;
    // A new evaluation replaces any earlier assessment, including a now-quiet result.
    this.db.prepare('DELETE FROM plan_attention WHERE owner_id=? AND plan_id=?').run(input.ownerId,input.planId);
    if(!attention || input.candidate.confidence<0.9) return;
    const context=this.db.prepare(`SELECT m.timezone, b.revision, sv.expires_at FROM members m
      JOIN background_ai_settings b ON b.member_id=m.id AND b.enabled=1 AND b.consent_version='background-ai-v1'
      JOIN source_items si ON si.owner_id=m.id JOIN source_versions sv ON sv.source_id=si.id AND sv.id=si.current_version_id
      JOIN google_connections gc ON gc.id=si.connection_id AND gc.member_id=m.id AND gc.generation=si.generation AND gc.status='active'
      WHERE m.id=? AND m.active=1 AND sv.id=? AND si.state='available' AND sv.availability='available' AND sv.expires_at>?`).get(input.ownerId,input.sourceVersionId,this.clock().toISOString()) as {timezone:string;revision:number;expires_at:string}|undefined;
    if(!context) return;
    const version=this.db.prepare('SELECT COALESCE(pending_version_id,current_version_id) id FROM plans WHERE id=?').get(input.planId) as {id:string}|undefined;
    if(!version) return;
    const nextReview=nextMorningReview(this.db,input.ownerId,context.timezone,this.clock());
    // Same-day only: anything with a known time after the next morning review waits for it.
    const when=startsAt(input.candidate.safeFacts.time,context.timezone);
    if(when!==undefined && when>=Date.parse(nextReview)) return;
    const expires=[context.expires_at,nextReview,new Date(this.clock().getTime()+3600000).toISOString()].sort()[0]!;
    this.db.prepare('INSERT INTO plan_attention VALUES (?,?,?,?,?,?,?,?)').run(input.ownerId,input.planId,version.id,input.sourceVersionId,context.revision,attention.kind,JSON.stringify(encryptJson(attention,this.key,`plan-attention:${input.ownerId}:${input.planId}`)),expires);
  }
  current(actor:{memberId:string;householdId:string},planId:string) {
    const row=this.db.prepare(`SELECT a.kind FROM plan_attention a JOIN members m ON m.id=a.owner_id AND m.active=1
      JOIN background_ai_settings b ON b.member_id=m.id AND b.enabled=1 AND b.consent_version='background-ai-v1' AND b.revision=a.consent_revision
      JOIN plans p ON p.id=a.plan_id AND p.household_id=m.household_id AND a.plan_version_id=COALESCE(p.pending_version_id,p.current_version_id)
      JOIN source_versions sv ON sv.id=a.source_version_id AND sv.availability='available' AND sv.expires_at>?
      JOIN source_items si ON si.id=sv.source_id AND si.owner_id=m.id AND si.current_version_id=sv.id AND si.state='available'
      JOIN google_connections gc ON gc.id=si.connection_id AND gc.member_id=m.id AND gc.status='active' AND gc.generation=si.generation
      WHERE a.owner_id=? AND m.household_id=? AND a.plan_id=? AND a.expires_at>?`).get(this.clock().toISOString(),actor.memberId,actor.householdId,planId,this.clock().toISOString()) as {kind:'coordination'|'decision'|'disruption'}|undefined;
    if(!row) return null;
    try {
      const plan=new PlanRepository(this.db,this.key,this.clock).detail(planId,actor.memberId);
      if(['dismissed','archived'].includes(plan.status) || !plan.pendingFacts && (plan.savedInPlanner || plan.calendarAction))return null;
      const time=(plan.pendingFacts??plan.facts).time;
      if(time?.kind==='timed' && Date.parse(time.end)<=this.clock().getTime())return null;
      return row.kind;
    } catch {return null;}
  }
}
