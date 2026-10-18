import type Database from 'better-sqlite3';
import { PlanRepository } from '../repos/plans.js';
import type { CalendarActionService } from './calendar-actions.js';
type Actor = { memberId: string; householdId: string };

export class PlanDecisionService {
  constructor(private readonly db: Database.Database, private readonly plans: PlanRepository, private readonly actions: CalendarActionService, private readonly clock: () => Date = () => new Date()) {}
  decide(actor: Actor, id: string, revision: number, choice: 'keep' | 'calendar') {
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId)) throw new Error('NOT_FOUND');
      let plan = this.plans.detail(id, actor.memberId);
      const existing = this.db.prepare("SELECT id FROM calendar_actions WHERE plan_id = ? AND kind = 'create' ORDER BY created_at DESC LIMIT 1").get(id) as { id: string } | undefined;
      // A response lost after queueing must never create another Google event.
      if (choice === 'calendar' && existing) return this.actions.status(actor, existing.id);
      if (plan.revision !== revision) throw new Error('STALE_REVISION');
      if (['dismissed', 'archived'].includes(plan.status)) throw new Error('PLAN_DISMISSED');
      if (choice === 'keep') {
        this.db.prepare('UPDATE plans SET kept_at = COALESCE(kept_at, ?) WHERE id = ?').run(this.clock().toISOString(), id);
        return { planId: id, state: 'kept' as const };
      }
      const facts = plan.pendingFacts ?? plan.facts;
      if (!facts.time || facts.time.kind === 'unresolved' || facts.time.kind === 'deadline' || facts.unresolvedFields.length) throw new Error('PLAN_TIME_INCOMPLETE');
      if (plan.visibility === 'private') plan = this.plans.share(id, actor.memberId, plan.revision, facts);
      // Sharing and queueing roll back together if the destination is unavailable.
      return this.actions.apply(actor, id, plan.revision, 'create', `direct-calendar:${id}`);
    })();
  }
}
