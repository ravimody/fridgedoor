import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { JobQueue } from './queue.js';
import { SourceRepository } from '../repos/sources.js';

export class Scheduler {
  constructor(private readonly db: Database.Database, private readonly queue: JobQueue, private readonly sources: SourceRepository, private readonly clock: () => Date = () => new Date()) {}
  tick() {
    const now = this.clock(); const bucket = Math.floor(now.getTime() / 300_000) * 300_000;
    const connections = this.db.prepare("SELECT id, generation FROM google_connections WHERE status = 'active'").all() as Array<{ id: string; generation: number }>;
    for (const connection of connections) {
      this.sources.ensureGmailState(connection.id, connection.generation);
      this.queue.enqueue({ reviveTerminal: false, kind: 'gmail_sync', scopeId: connection.id, dedupeKey: `gmail-sync:${connection.id}:${bucket}`, payload: { connectionId: connection.id, generation: connection.generation } });
      const selections = this.db.prepare("SELECT cs.id FROM calendar_selections cs JOIN members m ON m.id = (SELECT member_id FROM google_connections WHERE id = cs.connection_id) LEFT JOIN destination_bindings db ON db.household_id = m.household_id AND db.calendar_key = cs.calendar_key AND db.active = 1 WHERE cs.connection_id = ? AND cs.generation = ? AND (cs.selected = 1 OR db.id IS NOT NULL)").all(connection.id, connection.generation) as Array<{ id: string }>;
      for (const selection of selections) this.queue.enqueue({ reviveTerminal: false, kind: 'calendar_sync', scopeId: connection.id, dedupeKey: `calendar-sync:${selection.id}:${bucket}`, payload: { connectionId: connection.id, generation: connection.generation, calendarSelectionId: selection.id } });
    }
    const retentionBucket = Math.floor(now.getTime() / 86_400_000);
    this.queue.enqueue({ reviveTerminal: false, kind: 'retention', scopeId: 'system', dedupeKey: `retention:${retentionBucket}`, payload: {} });
    const reminderBucket = Math.floor(now.getTime() / 30_000);
    this.queue.enqueue({ reviveTerminal: false, kind: 'reminder_delivery', scopeId: 'system', dedupeKey: `reminders:${reminderBucket}`, payload: {} });
    this.queue.enqueue({ reviveTerminal: false, kind: 'morning_digest', scopeId: 'system', dedupeKey: `digest:${reminderBucket}`, payload: {} });
    const dailyOwners = this.db.prepare(`SELECT m.id as owner_id, m.household_id, m.timezone, d.local_time, s.revision as consent_revision
      FROM members m JOIN digest_settings d ON d.member_id = m.id AND d.enabled = 1
      JOIN daily_ai_settings s ON s.member_id = m.id AND s.enabled = 1 AND s.consent_version = 'daily-assistant-v1'
      WHERE m.active = 1`).all() as Array<{ owner_id: string; household_id: string; timezone: string; local_time: string; consent_revision: number }>;
    const maintenanceOwners = this.db.prepare(`SELECT m.id as owner_id, m.household_id, m.timezone, s.revision as consent_revision
      FROM members m JOIN daily_ai_settings s ON s.member_id = m.id AND s.enabled = 1 AND s.consent_version = 'daily-assistant-v1'
      WHERE m.active = 1`).all() as Array<{ owner_id: string; household_id: string; timezone: string; consent_revision: number }>;
    for (const owner of maintenanceOwners) {
      const local = DateTime.fromJSDate(now).setZone(owner.timezone);
      if (!local.isValid) continue;
      const date = local.toISODate()!;
      if(local.hour>=2 && this.db.prepare('SELECT 1 FROM personal_relevance WHERE owner_id=? AND enabled=1').get(owner.owner_id)) {
        const learningKey=`relevance-learning:${owner.owner_id}:${date}`;
        if(!this.queue.getByDedupe(learningKey)) this.queue.enqueue({reviveTerminal:false, kind:'relevance_learning',scopeId:`daily:${owner.owner_id}`,dedupeKey:learningKey,payload:{ownerId:owner.owner_id,householdId:owner.household_id,localDate:date,timezone:owner.timezone,consentRevision:owner.consent_revision}});
      }
      const maintenanceKey = `daily-maintenance:${owner.owner_id}:${date}:${owner.timezone}:${owner.consent_revision}`;
      this.queue.enqueue({ reviveTerminal: false, kind: 'daily_maintenance', scopeId: `daily:${owner.owner_id}`, dedupeKey: maintenanceKey, runAfter: now, payload: { ownerId: owner.owner_id, householdId: owner.household_id, localDate: date, timezone: owner.timezone, consentRevision: owner.consent_revision, logicalRequest: maintenanceKey } });
    }
    for (const owner of dailyOwners) {
      const local = DateTime.fromJSDate(now).setZone(owner.timezone);
      if (!local.isValid) continue;
      const date = local.toISODate()!;
      const due = DateTime.fromISO(`${date}T${owner.local_time}`, { zone: owner.timezone }).getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0];
      if (!due?.isValid) continue;
      const windowEnd = DateTime.min(due.plus({ hours: 4 }), local.plus({ days: 1 }).startOf('day'));
      if (local < due.minus({ minutes: 10 }) || local >= windowEnd) continue;
      const dedupeKey = `daily-overview:${owner.owner_id}:${date}:${owner.timezone}:${owner.consent_revision}`;
      this.queue.enqueue({ reviveTerminal: false, kind: 'daily_overview', scopeId: `daily:${owner.owner_id}`, dedupeKey, runAfter: now, payload: { ownerId: owner.owner_id, householdId: owner.household_id, localDate: date, timezone: owner.timezone, consentRevision: owner.consent_revision, logicalRequest: dedupeKey } });
    }
    return { connections: connections.length, bucket };
  }
}
