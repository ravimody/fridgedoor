import type Database from 'better-sqlite3';
import type { TrialSummary } from '@fridgedoor/contracts';
import { decryptJson, encryptJson } from '../crypto.js';
type Actor = { memberId: string; householdId: string };
export type RelevanceState = { preferences: TrialSummary['preferences']; ignored: Record<string, number>; inputDigest: string; generatedAt: string | null };
export class PersonalRelevanceRepository {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: () => Date = () => new Date()) {}
  read(actor: Actor) {
    if (!this.db.prepare('SELECT 1 FROM members WHERE id=? AND household_id=? AND active=1').get(actor.memberId, actor.householdId)) throw new Error('NOT_FOUND');
    const row = this.db.prepare('SELECT * FROM personal_relevance WHERE owner_id=?').get(actor.memberId) as {enabled:number;revision:number;encrypted_state:string}|undefined;
    const state: RelevanceState = row ? decryptJson(JSON.parse(row.encrypted_state), this.key, `personal-relevance:${actor.memberId}`) : {preferences:[],ignored:{},inputDigest:'',generatedAt:null};
    return { enabled: row?.enabled === 1, revision: row?.revision ?? 0, state };
  }
  write(actor: Actor, expectedRevision: number, enabled: boolean, state: RelevanceState) {
    return this.db.transaction(() => {
      if (this.read(actor).revision !== expectedRevision) throw new Error('STALE_REVISION');
      this.db.prepare(`INSERT INTO personal_relevance VALUES (?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,encrypted_state=excluded.encrypted_state,updated_at=excluded.updated_at`).run(actor.memberId, Number(enabled), expectedRevision+1, JSON.stringify(encryptJson(state,this.key,`personal-relevance:${actor.memberId}`)),this.clock().toISOString());
      return this.read(actor);
    })();
  }
  context(actor: Actor) {
    const profile=this.read(actor);
    const ai=this.db.prepare("SELECT 1 FROM daily_ai_settings WHERE member_id=? AND enabled=1 AND consent_version='daily-assistant-v1'").get(actor.memberId);
    return profile.enabled && ai ? profile.state.preferences.map(({direction,pattern})=>({direction,pattern})) : [];
  }
  invalidateRating(actor: Actor, id: string) {
    const profile=this.read(actor);
    if (!profile.revision) return;
    this.write(actor,profile.revision,profile.enabled,{...profile.state,inputDigest:'',preferences:profile.state.preferences.filter(rule=>!rule.evidenceIds.includes(id))});
  }
}
