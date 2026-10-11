import { PlanAttentionService, nextMorningReview } from './plan-attention.js';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { requestOutcomes } from '@fridgedoor/contracts';
import { decryptJson } from '../crypto.js';
import { ASSISTANT_CONSENT, AssistantService } from '../ai/assistant-service.js';
import { PlanRepository } from '../repos/plans.js';
import type { PushProvider, PushPayload } from '../providers/push.js';
import { BackgroundAiService } from './background-ai.js';
type Actor = { memberId: string; householdId: string };
type Kind = 'review' | 'failure' | 'update';
type Event = { source_kind: 'request' | 'plan' | 'action' | 'email_volume'; source_id: string };
type Group = { id: string; member_id: string; kind: Kind; expires_at: string };
export class ActivityNotificationService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly push: PushProvider, private readonly available: boolean, private readonly clock: () => Date = () => new Date()) {}
  private present(memberId: string) { return Boolean(this.db.prepare('SELECT 1 FROM activity_presence WHERE member_id = ? AND seen_at > ?').get(memberId, new Date(this.clock().getTime() - 45000).toISOString())); }
  private enqueue(actor: Actor, kind: Kind, eventKey: string, sourceKind: Event['source_kind'], sourceId: string) {
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM activity_events WHERE member_id = ? AND event_key = ?').get(actor.memberId, eventKey)) return;
      const now = this.clock(); const timestamp = now.toISOString();
      let group = this.db.prepare('SELECT id FROM activity_groups WHERE member_id = ? AND kind = ? AND ready_at > ? ORDER BY created_at LIMIT 1').get(actor.memberId, kind, timestamp) as { id: string } | undefined;
      if (!group) {
        group = { id: randomUUID() };
        this.db.prepare('INSERT INTO activity_groups VALUES (?, ?, ?, ?, ?, ?)').run(group.id, actor.memberId, kind, new Date(now.getTime() + 45000).toISOString(), new Date(now.getTime() + 86400000).toISOString(), timestamp);
        // Freeze the enrolled devices for this batch; later enrollment gets future updates.
        this.db.prepare("INSERT INTO activity_deliveries SELECT ?, id, 'pending', 0, ?, ? FROM push_subscriptions WHERE member_id = ? AND status = 'enabled'").run(group.id, timestamp, timestamp, actor.memberId);
      }
      this.db.prepare('INSERT INTO activity_events VALUES (?, ?, ?, ?, ?)').run(actor.memberId, eventKey, sourceKind, sourceId, group.id);
    })();
  }
  private requestKind(actor: Actor, id: string): Kind | null {
    if (!this.db.prepare('SELECT 1 FROM assistant_settings WHERE member_id = ? AND consent_version = ?').get(actor.memberId, ASSISTANT_CONSENT)) return null;
    const run = new AssistantService(this.db, this.key, true, undefined, this.clock).list(actor).find((item) => item.id === id);
    if (!run || !['succeeded','failed'].includes(run.state)) return null;
    const outcomes = requestOutcomes(run);
    if (outcomes.includes('needs_attention')) return 'failure';
    if (outcomes.includes('needs_review')) return 'review';
    // A reviewed proposal shouldn't trigger a second completion alert.
    return outcomes.some((item) => ['added','reply'].includes(item)) ? 'update' : null;
  }
  private planPending(actor: Actor, id: string) {
    try { const p = new PlanRepository(this.db, this.key, this.clock).detail(id, actor.memberId); return !['dismissed','archived'].includes(p.status) && Boolean(p.pendingFacts || !p.savedInPlanner && !p.calendarAction); } catch { return false; }
  }
  // Interrupt for a concrete deadline or a fresh source-backed consequential decision.
  private urgentPlan(actor: Actor, id: string) {
    if(!this.planPending(actor,id)) return false;
    const plan=new PlanRepository(this.db,this.key,this.clock).detail(id,actor.memberId);
    const time=(plan.pendingFacts??plan.facts).time;
    if(time?.kind!=='deadline') return Boolean(new PlanAttentionService(this.db,this.key,this.clock).current(actor,id));
    const member=this.db.prepare('SELECT timezone FROM members WHERE id=? AND active=1').get(actor.memberId) as {timezone:string}|undefined;
    if(!member) return false;
    const now=DateTime.fromJSDate(this.clock());
    const next=DateTime.fromISO(nextMorningReview(this.db,actor.memberId,member.timezone,this.clock()));
    const deadline=DateTime.fromISO(time.at);
    return deadline>now && deadline<next;
  }
  private reviewCount(actor: Actor, events: Event[]) {
    let count = 0;
    for (const event of events) {
      if (event.source_kind === 'request') {
        const run = new AssistantService(this.db, this.key, true, undefined, this.clock).list(actor).find((item) => item.id === event.source_id);
        if (run?.result) {
          count += run.result.items.filter((_, index) => !run.reviews?.some((review) => review.target === `item:${index}`)).length;
          count += run.result.knowledge.filter((_, index) => !run.reviews?.some((review) => review.target === `knowledge:${index}`)).length;
        }
      } else if (event.source_kind === 'plan') count++;
    }
    return count;
  }
  private copy(actor: Actor, group: Group, events: Event[]) {
    if (group.kind === 'review') {
      let calendar = 0; let list = 0; let facts = 0;
      for (const event of events) {
        if (event.source_kind === 'plan') { calendar++; continue; }
        if (event.source_kind !== 'request') continue;
        const run = new AssistantService(this.db, this.key, true, undefined, this.clock).list(actor).find((item) => item.id === event.source_id);
        if (!run?.result) continue;
        for (const [index, item] of run.result.items.entries()) {
          if (run.reviews?.some((review) => review.target === `item:${index}`)) continue;
          if (item.kind === 'event') calendar++; else list++;
        }
        for (const index of run.result.knowledge.keys()) if (!run.reviews?.some((review) => review.target === `knowledge:${index}`)) facts++;
      }
      const parts = [
        calendar ? `${calendar} calendar suggestion${calendar === 1 ? '' : 's'}` : '',
        list ? `${list} list item${list === 1 ? '' : 's'}` : '',
        facts ? `${facts} saved fact update${facts === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      if (parts.length) return `${parts.join(' and ')} ${calendar + list + facts === 1 ? 'is' : 'are'} ready for review.`;
      const count = this.reviewCount(actor, events) || events.length;
      return `${count} household suggestion${count === 1 ? ' is' : 's are'} ready for review.`;
    }
    if (group.kind === 'failure' && events.every(event=>event.source_kind==='plan')) {
      const attention=new PlanAttentionService(this.db,this.key,this.clock);
      const kinds=events.map(event=>attention.current(actor,event.source_id)).filter(Boolean);
      if(kinds.includes('coordination')) return 'Household coordination needs an answer before your next morning review.';
      if(kinds.includes('disruption')) return 'A change to household plans needs attention before your next morning review.';
      if(kinds.includes('decision')) return 'An unresolved household decision needs attention before your next morning review.';
      return 'A planner deadline needs attention before your next morning review.';
    }
    if (group.kind === 'failure') return events.some((event) => event.source_kind === 'action') ? 'A calendar change needs attention.' : 'Your assistant request needs attention.';
    return events.some((event) => event.source_kind === 'action') ? 'A calendar change was accepted by Google.' : 'Your assistant request finished processing.';
  }
  private valid(actor: Actor, group: Group, event: Event): string | null {
    if (event.source_kind === 'email_volume') {
      const status = new BackgroundAiService(this.db, true, this.clock).status(actor);
      return event.source_id === actor.memberId && status.enabled && status.connectionActive && status.volumeWarning ? '/dashboard/settings/email' : null;
    }
    if (event.source_kind === 'request') return this.requestKind(actor, event.source_id) === group.kind ? `/dashboard/requests/${event.source_id}` : null;
    if (event.source_kind === 'plan') return this.urgentPlan(actor, event.source_id) ? `/dashboard/plans/${event.source_id}` : null;
    const action = this.db.prepare("SELECT a.state, a.plan_id FROM calendar_actions a JOIN plans p ON p.id = a.plan_id WHERE a.id = ? AND a.actor_id = ? AND p.household_id = ? AND (p.visibility = 'shared' OR p.owner_id = ?) AND a.id = (SELECT id FROM calendar_actions WHERE plan_id = p.id ORDER BY rowid DESC LIMIT 1)").get(event.source_id, actor.memberId, actor.householdId, actor.memberId) as { state: string; plan_id: string } | undefined;
    const kind = action?.state === 'succeeded' ? 'update' : action && ['failed','conflict','needs_reauth','canceled'].includes(action.state) ? 'failure' : null;
    return action && kind === group.kind ? `/dashboard/plans/${action.plan_id}` : null;
  }
  private discover() {
    const started = (this.db.prepare('SELECT started_at FROM activity_config WHERE id=1').get() as { started_at: string }).started_at;
    const since = [started, new Date(this.clock().getTime() - 86400000).toISOString()].sort()[1]!;
    const members = this.db.prepare("SELECT id, household_id FROM members WHERE active = 1 AND id IN (SELECT member_id FROM push_subscriptions WHERE status = 'enabled')").all() as { id: string; household_id: string }[];
    for (const member of members) {
      const actor = { memberId: member.id, householdId: member.household_id };
      const background = new BackgroundAiService(this.db, true, this.clock).status(actor);
      if (background.enabled && background.connectionActive && background.volumeWarning) this.db.transaction(() => {
        const recent = this.db.prepare(`SELECT 1 FROM activity_events e JOIN activity_groups g ON g.id = e.group_id
          WHERE e.member_id = ? AND e.source_kind = 'email_volume' AND g.created_at > ?`).get(member.id, new Date(this.clock().getTime() - 86400000).toISOString());
        if (!recent) this.enqueue(actor, 'failure', `email-volume:${this.clock().toISOString()}`, 'email_volume', member.id);
      })();
      const requests = this.db.prepare("SELECT id,state FROM assistant_runs WHERE owner_id = ? AND created_at >= ? AND expires_at > ? AND state IN ('succeeded','failed')").all(member.id, since, this.clock().toISOString()) as { id: string; state: string }[];
      for (const request of requests) { const kind = this.requestKind(actor, request.id); if (kind) this.enqueue(actor, kind, `request:${request.id}:${request.state}`, 'request', request.id); }
      const plans = this.db.prepare("SELECT p.id, COALESCE(p.pending_version_id,p.current_version_id) version_id FROM plans p JOIN plan_versions v ON v.id = COALESCE(p.pending_version_id,p.current_version_id) WHERE p.household_id = ? AND (p.visibility = 'shared' OR p.owner_id = ?) AND v.origin = 'extraction' AND v.created_at >= ? AND p.status IN ('proposed','needs_details')").all(member.household_id, member.id, since) as { id: string; version_id: string }[];
      for (const plan of plans) if (this.urgentPlan(actor, plan.id)) this.enqueue(actor, 'failure', `plan:${plan.id}:${plan.version_id}`, 'plan', plan.id);
      const actions = this.db.prepare("SELECT id,state FROM calendar_actions WHERE actor_id = ? AND updated_at >= ? AND state IN ('succeeded','failed','conflict','needs_reauth','canceled')").all(member.id, since) as { id: string; state: string }[];
      for (const action of actions) this.enqueue(actor, action.state === 'succeeded' ? 'update' : 'failure', `action:${action.id}:${action.state}`, 'action', action.id);
    }
  }
  async deliverDue() {
    if (!this.available) return { sent: 0 };
    this.discover(); let sent = 0;
    const groups = this.db.prepare('SELECT * FROM activity_groups WHERE ready_at <= ? AND expires_at > ? ORDER BY ready_at').all(this.clock().toISOString(), this.clock().toISOString()) as Group[];
    for (const group of groups) {
      const member = this.db.prepare('SELECT household_id FROM members WHERE id = ? AND active = 1').get(group.member_id) as { household_id: string } | undefined;
      const actor = { memberId: group.member_id, householdId: member?.household_id ?? '' };
      const events = this.db.prepare('SELECT source_kind,source_id FROM activity_events WHERE group_id = ?').all(group.id) as Event[];
      const devices = this.db.prepare("SELECT subscription_id FROM activity_deliveries WHERE group_id = ? AND state IN ('pending','uncertain')").all(group.id) as { subscription_id: string }[];
      for (const device of devices) {
        const now = this.clock(); const timestamp = now.toISOString();
        const active = this.db.prepare('SELECT 1 FROM members WHERE id=? AND household_id=? AND active=1').get(actor.memberId, actor.householdId);
        const urls = active ? [...new Set(events.map((event) => this.valid(actor, group, event)).filter((url): url is string => Boolean(url)))] : [];
        if (!urls.length || group.kind === 'update' && this.present(group.member_id)) { this.db.prepare("UPDATE activity_deliveries SET state = 'suppressed', updated_at = ? WHERE group_id = ? AND subscription_id = ? AND state IN ('pending','uncertain')").run(timestamp, group.id, device.subscription_id); continue; }
        const recipient = this.db.prepare("SELECT ps.encrypted_endpoint,ps.encrypted_keys FROM push_subscriptions ps JOIN members m ON m.id=ps.member_id WHERE ps.id=? AND ps.member_id=? AND ps.status='enabled' AND m.active=1").get(device.subscription_id, group.member_id) as { encrypted_endpoint: string; encrypted_keys: string } | undefined;
        if (!recipient || timestamp >= group.expires_at) continue;
        const claim = this.db.transaction(() => {
          const old = this.db.prepare('SELECT state,attempts,next_attempt_at,updated_at FROM activity_deliveries WHERE group_id=? AND subscription_id=?').get(group.id, device.subscription_id) as { state: string; attempts: number; next_attempt_at: string; updated_at: string };
          if (!['pending','uncertain'].includes(old.state) || old.attempts >= 3 || old.next_attempt_at > timestamp || old.state === 'pending' && old.attempts > 0 && Date.parse(old.updated_at) > now.getTime() - 60000) return 0;
          this.db.prepare("UPDATE activity_deliveries SET state='pending',attempts=attempts+1,updated_at=? WHERE group_id=? AND subscription_id=?").run(timestamp, group.id, device.subscription_id);
          return old.attempts + 1;
        })();
        if (!claim) continue;
        let result: 'accepted' | 'gone' | 'retry' = 'retry';
        try {
          const endpoint = decryptJson<string>(JSON.parse(recipient.encrypted_endpoint), this.key, `push-endpoint:${device.subscription_id}`);
          const keys = decryptJson<{ p256dh: string; auth: string }>(JSON.parse(recipient.encrypted_keys), this.key, `push-keys:${device.subscription_id}`);
          const volumeOnly = events.every(event => event.source_kind === 'email_volume');
          const title = volumeOnly ? 'Fridgedoor: unusual email processing' : group.kind === 'review' ? 'Fridgedoor review' : group.kind === 'failure' ? 'Fridgedoor needs attention' : 'Fridgedoor update';
          const payload: PushPayload = { title, ...(volumeOnly ? {} : { body: this.copy(actor, group, events) }), url: urls.length === 1 ? urls[0]! : '/dashboard/', tag: `activity-${group.id}` };
          result = await this.push.send({ id: device.subscription_id, endpoint, ...keys, label: '' }, payload, Math.max(1, Math.floor((Date.parse(group.expires_at) - now.getTime()) / 1000)));
        } catch { /* No private contents or endpoint in logs. Retry durably. */ }
        const finished = this.clock();
        if (result === 'gone') this.db.prepare("UPDATE push_subscriptions SET status='disabled',updated_at=? WHERE id=? AND encrypted_endpoint=? AND encrypted_keys=?").run(finished.toISOString(), device.subscription_id, recipient.encrypted_endpoint, recipient.encrypted_keys);
        this.db.prepare('UPDATE activity_deliveries SET state=?,next_attempt_at=?,updated_at=? WHERE group_id=? AND subscription_id=? AND attempts=?').run(result === 'accepted' ? 'accepted' : result === 'gone' ? 'expired' : 'uncertain', new Date(finished.getTime() + claim * 60000).toISOString(), finished.toISOString(), group.id, device.subscription_id, claim);
        if (result === 'accepted') sent++;
      }
    }
    this.db.prepare('DELETE FROM activity_groups WHERE expires_at < ?').run(new Date(this.clock().getTime() - 8 * 86400000).toISOString());
    this.db.prepare('DELETE FROM activity_presence WHERE seen_at < ?').run(new Date(this.clock().getTime() - 86400000).toISOString());
    return { sent };
  }
}
