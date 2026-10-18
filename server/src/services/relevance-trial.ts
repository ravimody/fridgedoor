import { z } from 'zod';
import { DateTime } from 'luxon';
import { PersonalRelevanceRepository } from '../repos/personal-relevance.js';
import { TRIAL_SUMMARY_VERSION } from '../ai/relevance-summary.js';
import { RELEVANCE_GUIDANCE_VERSION } from '../ai/relevance-guidance.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { trialRatingSchema, type TrialItem, type PlanFacts, trialSummarySchema, type TrialSummary } from '@fridgedoor/contracts';
import { digest, encryptJson, decryptJson } from '../crypto.js';
import { PlanRepository } from '../repos/plans.js';
import type { TrialSummaryProvider } from '../ai/relevance-summary.js';
import { lazy, type Lazy } from '../llm/hub.js';
type Actor = { memberId: string; householdId: string };
type Row = { id: string; plan_id: string | null; encrypted_snapshot: string; encrypted_rating: string | null; revision: number; expires_at: string };
type Snapshot = { facts: PlanFacts; observedAt: string };
export class RelevanceTrialService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: () => Date = () => new Date(), private readonly provider: Lazy<TrialSummaryProvider | undefined> = undefined) {}
  private authorize(actor: Actor) {
    if (!this.db.prepare('SELECT 1 FROM members WHERE id=? AND household_id=? AND active=1').get(actor.memberId, actor.householdId)) throw new Error('NOT_FOUND');
  }
  // Explicit operator preparation only; viewing the trial never creates a new batch.
  prepare(actor: Actor, planIds: string[], append = false) {
    this.authorize(actor);
    if (!planIds.length || planIds.length > 10 || new Set(planIds).size !== planIds.length) throw new Error('INVALID_BATCH');
    const repo = new PlanRepository(this.db, this.key, this.clock);
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM relevance_trial_items WHERE owner_id=? AND expires_at<=?').run(actor.memberId, this.clock().toISOString());
      const current = this.list(actor);
      if (current.items.length && !append) return current;
      const offset = (this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM relevance_trial_items WHERE owner_id=?').get(actor.memberId) as {n:number}).n;
      const now = this.clock().toISOString();
      const expires = new Date(this.clock().getTime() + 30 * 86400000).toISOString();
      for (const [position, planId] of planIds.entries()) {
        const plan = repo.detail(planId, actor.memberId);
        const version = this.db.prepare("SELECT v.created_at FROM plan_versions v JOIN plans p ON v.id=COALESCE(p.pending_version_id,p.current_version_id) WHERE p.id=? AND v.origin='extraction'").get(planId) as { created_at: string } | undefined;
        if (!version || Date.parse(version.created_at) < this.clock().getTime() - 14 * 86400000) throw new Error('NOT_RECENT_SUGGESTION');
        const id = randomUUID();
        const snapshot: Snapshot = { facts: plan.pendingFacts ?? plan.facts, observedAt: version.created_at };
        this.db.prepare('INSERT INTO relevance_trial_items (id,owner_id,plan_id,encrypted_snapshot,position,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(id, actor.memberId, planId, JSON.stringify(encryptJson(snapshot, this.key, `trial:${actor.memberId}:${id}`)), position + offset, now, expires);
      }
      return this.list(actor);
    })();
  }
  next(actor: Actor) {
    this.authorize(actor);
    return this.db.transaction(() => {
      const current = this.list(actor);
      if (current.items.some(item => item.value === null)) return current;
      if (current.items.length >= 100) throw new Error('TRIAL_LIMIT');
      const cutoff = new Date(this.clock().getTime() - 14 * 86400000).toISOString();
      const rows = this.db.prepare(`SELECT p.id FROM plans p JOIN plan_versions v ON v.id=COALESCE(p.pending_version_id,p.current_version_id)
        WHERE p.household_id=? AND (p.visibility='shared' OR p.owner_id=?) AND p.status NOT IN ('dismissed','archived')
        AND v.origin='extraction' AND v.created_at>=?
        AND NOT EXISTS (SELECT 1 FROM relevance_trial_items t WHERE t.owner_id=? AND t.plan_id=p.id AND t.expires_at>?)
        ORDER BY RANDOM() LIMIT ?`).all(actor.householdId, actor.memberId, cutoff, actor.memberId, this.clock().toISOString(), Math.min(5,100-current.items.length)) as {id:string}[];
      return rows.length ? this.prepare(actor, rows.map(row=>row.id), true) : current;
    })();
  }
  private input(actor: Actor) {
    return this.list(actor).items.filter(item=>item.value!==null).map(item=>({id:item.id,title:item.facts.title,notes:(item.facts.notes??'').slice(0,800),vote:item.value!,reason:item.reason,...(item.source?.available?{source:{sender:item.source.sender?.slice(0,180)??null,excerpt:item.source.excerpt}}:{})}));
  }
  summary(actor: Actor) {
    const input = this.input(actor);
    const hash = digest(JSON.stringify({input, version:TRIAL_SUMMARY_VERSION, guidance:RELEVANCE_GUIDANCE_VERSION}));
    const row = this.db.prepare('SELECT encrypted_summary,generated_at FROM relevance_trial_summaries WHERE owner_id=? AND input_digest=? AND expires_at>?').get(actor.memberId,hash,this.clock().toISOString()) as {encrypted_summary:string;generated_at:string}|undefined;
    return row ? { result: decryptJson<TrialSummary>(JSON.parse(row.encrypted_summary),this.key,`trial-summary:${actor.memberId}`), generatedAt:row.generated_at } : null;
  }
  private summarizing = new Set<string>();
  async compact(actor: Actor) {
    const current = this.summary(actor); if(current) return current;
    const provider=lazy(this.provider); if(!provider) throw new Error('SUMMARY_UNAVAILABLE');
    if(this.summarizing.has(actor.memberId)) throw new Error('SUMMARY_BUSY');
    const input=this.input(actor); if(!input.some(item=>item.vote!=='skip')) throw new Error('RATINGS_REQUIRED');
    this.summarizing.add(actor.memberId);
    try {
      const result=trialSummarySchema.parse(await provider.summarize(input));
      for(const rule of result.preferences) {
        if(rule.evidenceIds.some(id=>!input.some(item=>item.id===id && (rule.direction==='uncertain' || item.vote===(rule.direction==='prefer'?'useful':'not_useful'))))) throw new Error('INVALID_SUMMARY_EVIDENCE');
      }
      const hash=digest(JSON.stringify({input, version:TRIAL_SUMMARY_VERSION, guidance:RELEVANCE_GUIDANCE_VERSION}));
      if(hash!==digest(JSON.stringify({input:this.input(actor), version:TRIAL_SUMMARY_VERSION, guidance:RELEVANCE_GUIDANCE_VERSION}))) throw new Error('STALE_REVISION');
      const now=this.clock().toISOString();
      this.db.prepare(`INSERT INTO relevance_trial_summaries VALUES (?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET input_digest=excluded.input_digest,encrypted_summary=excluded.encrypted_summary,generated_at=excluded.generated_at,expires_at=excluded.expires_at`).run(actor.memberId,hash,JSON.stringify(encryptJson(result,this.key,`trial-summary:${actor.memberId}`)),now,new Date(this.clock().getTime()+30*86400000).toISOString());
      return {result,generatedAt:now};
    } finally {this.summarizing.delete(actor.memberId);}
  }
  learning(actor: Actor) {
    const profile=new PersonalRelevanceRepository(this.db,this.key,this.clock).read(actor);
    return {enabled:profile.enabled,revision:profile.revision,preferences:profile.state.preferences,generatedAt:profile.state.generatedAt};
  }
  configureLearning(actor: Actor, raw: unknown) {
    const input=z.object({enabled:z.boolean(),expectedRevision:z.number().int().nonnegative(),consentVersion:z.literal('personal-relevance-v1').optional()}).strict().parse(raw);
    if(input.enabled && input.consentVersion!=='personal-relevance-v1') throw new Error('CONSENT_REQUIRED');
    const repo=new PersonalRelevanceRepository(this.db,this.key,this.clock), profile=repo.read(actor);
    repo.write(actor,input.expectedRevision,input.enabled,profile.state);
    return this.learning(actor);
  }
  forgetLearning(actor: Actor, raw: unknown) {
    const input=z.object({expectedRevision:z.number().int().nonnegative()}).strict().parse(raw);
    const repo=new PersonalRelevanceRepository(this.db,this.key,this.clock), profile=repo.read(actor);
    repo.write(actor,input.expectedRevision,profile.enabled,{preferences:[],inputDigest:'',generatedAt:null,ignored:Object.fromEntries(this.list(actor).items.filter(item=>item.value!==null).map(item=>[item.id,item.revision]))});
    return this.learning(actor);
  }
  async learn(actor: Actor, expected: {localDate:string;timezone:string;consentRevision:number}) {
    const repo=new PersonalRelevanceRepository(this.db,this.key,this.clock), profile=repo.read(actor);
    const allowed=()=>{
      const member=this.db.prepare("SELECT m.timezone FROM members m JOIN daily_ai_settings s ON s.member_id=m.id WHERE m.id=? AND m.household_id=? AND m.active=1 AND s.enabled=1 AND s.consent_version='daily-assistant-v1' AND s.revision=?").get(actor.memberId,actor.householdId,expected.consentRevision) as {timezone:string}|undefined;
      return member?.timezone===expected.timezone && DateTime.fromJSDate(this.clock()).setZone(expected.timezone).toISODate()===expected.localDate && repo.read(actor).enabled;
    };
    if(!profile.enabled || !allowed()) return;
    const input=()=>{
      const revisions=new Map(this.list(actor).items.map(item=>[item.id,item.revision]));
      return this.input(actor).filter(item=>revisions.get(item.id)!==profile.state.ignored[item.id]);
    };
    const examples=input();
    const hash=digest(JSON.stringify({examples,version:TRIAL_SUMMARY_VERSION,guidance:RELEVANCE_GUIDANCE_VERSION}));
    if(profile.state.inputDigest===hash || !examples.some(item=>item.vote!=='skip')) return;
    const provider=lazy(this.provider); if(!provider) throw new Error('SUMMARY_UNAVAILABLE');
    // Persist before calling the provider: crashes and competing workers cannot multiply daily spend.
    if(!this.db.prepare('INSERT OR IGNORE INTO relevance_learning_days VALUES (?,?)').run(actor.memberId,expected.localDate).changes) return;
    const result=trialSummarySchema.parse(await provider.summarize(examples,profile.state.preferences));
    for(const rule of result.preferences) {
      const unchanged=profile.state.preferences.some(old=>JSON.stringify(old)===JSON.stringify(rule));
      if(!unchanged && rule.evidenceIds.some(id=>!examples.some(item=>item.id===id && (rule.direction==='uncertain' || item.vote===(rule.direction==='prefer'?'useful':'not_useful'))))) throw new Error('INVALID_SUMMARY_EVIDENCE');
    }
    const preferences=result.preferences.filter(rule=>rule.direction!=='uncertain' && (
      profile.state.preferences.some(old=>JSON.stringify(old)===JSON.stringify(rule)) ||
      new Set(rule.evidenceIds).size>=2 || examples.some(item=>rule.evidenceIds.includes(item.id) && item.reason.trim())
    ));
    if(!allowed() || profile.revision!==repo.read(actor).revision || hash!==digest(JSON.stringify({examples:input(),version:TRIAL_SUMMARY_VERSION,guidance:RELEVANCE_GUIDANCE_VERSION}))) throw new Error('STALE_REVISION');
    repo.write(actor,profile.revision,true,{...profile.state,preferences,inputDigest:hash,generatedAt:this.clock().toISOString()});
  }
  list(actor: Actor) {
    this.authorize(actor);
    const rows = this.db.prepare('SELECT * FROM relevance_trial_items WHERE owner_id=? AND expires_at>? ORDER BY position').all(actor.memberId, this.clock().toISOString()) as Row[];
    const repo = new PlanRepository(this.db, this.key, this.clock);
    const items: TrialItem[] = [];
    for (const row of rows) {
      if (!row.plan_id) continue;
      try { repo.detail(row.plan_id, actor.memberId); } catch { continue; }
      const snapshot = decryptJson<Snapshot>(JSON.parse(row.encrypted_snapshot), this.key, `trial:${actor.memberId}:${row.id}`);
      const rating = row.encrypted_rating ? decryptJson<{ value: TrialItem['value']; reason: string }>(JSON.parse(row.encrypted_rating), this.key, `trial-rating:${actor.memberId}:${row.id}`) : { value: null, reason: '' };
      let source: TrialItem['source'] = {sender:null,excerpt:null,available:false};
      try { const evidence=repo.evidence(row.plan_id,actor.memberId); if(evidence.availability==='available') source={sender:evidence.sender??null,excerpt:evidence.text.slice(0,400),available:true}; } catch { /* Source content stays owner-only, even for a shared plan. */ }
      items.push({ id: row.id, ...snapshot, ...rating, revision: row.revision, source });
    }
    return { items, expiresAt: items.length ? rows[0]!.expires_at : null };
  }
  rate(actor: Actor, id: string, input: unknown) {
    const rating = trialRatingSchema.parse(input);
    return this.db.transaction(() => {
      const item = this.list(actor).items.find(item => item.id === id);
      if (!item) throw new Error('NOT_FOUND');
      if (item.revision !== rating.expectedRevision) throw new Error('STALE_REVISION');
      const encrypted = JSON.stringify(encryptJson({ value: rating.value, reason: rating.reason }, this.key, `trial-rating:${actor.memberId}:${id}`));
      new PersonalRelevanceRepository(this.db,this.key,this.clock).invalidateRating(actor,id);
      this.db.prepare('UPDATE relevance_trial_items SET encrypted_rating=?, revision=revision+1 WHERE id=? AND owner_id=? AND revision=?').run(encrypted, id, actor.memberId, rating.expectedRevision);
      return this.list(actor);
    })();
  }
  clear(actor: Actor) { this.authorize(actor); this.db.prepare('DELETE FROM personal_relevance WHERE owner_id=?').run(actor.memberId); this.db.prepare('DELETE FROM relevance_learning_days WHERE owner_id=?').run(actor.memberId); this.db.prepare('DELETE FROM relevance_trial_summaries WHERE owner_id=?').run(actor.memberId); this.db.prepare('DELETE FROM relevance_trial_items WHERE owner_id=?').run(actor.memberId); return { deleted: true }; }
}
