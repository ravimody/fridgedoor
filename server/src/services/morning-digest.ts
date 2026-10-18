import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { decryptJson, type Envelope } from '../crypto.js';
import type { PushProvider } from '../providers/push.js';
type Actor = { memberId: string; householdId: string };
type Settings = { enabled: number; local_time: string; revision: number };
export class MorningDigestService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly push: PushProvider, private readonly available: boolean, private readonly clock: () => Date = () => new Date()) {}
  private member(actor: Actor) {
    const member = this.db.prepare('SELECT timezone FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId) as { timezone: string } | undefined;
    if (!member) throw new Error('NOT_FOUND'); return member;
  }
  status(actor: Actor) {
    const member = this.member(actor);
    const settings = this.db.prepare('SELECT enabled, local_time, revision FROM digest_settings WHERE member_id = ?').get(actor.memberId) as Settings | undefined;
    const devices = this.db.prepare("SELECT count(*) AS n FROM push_subscriptions WHERE member_id = ? AND status = 'enabled'").get(actor.memberId) as { n: number };
    const last = this.db.prepare("SELECT local_date AS date, sum(state = 'accepted') AS accepted, sum(state IN ('pending','uncertain')) AS pending FROM digest_deliveries WHERE member_id = ? GROUP BY local_date ORDER BY local_date DESC LIMIT 1").get(actor.memberId) as { date: string; accepted: number; pending: number } | undefined;
    return { enabled: Boolean(settings?.enabled), localTime: settings?.local_time ?? '07:00', revision: settings?.revision ?? 0, timezone: member.timezone, available: this.available, devices: devices.n, lastDelivery: last ?? null };
  }
  set(actor: Actor, input: { enabled: boolean; localTime: string; expectedRevision: number }) {
    return this.db.transaction(() => {
      const status = this.status(actor);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)) throw new Error('INVALID_DIGEST_TIME');
      if (status.revision !== input.expectedRevision) throw new Error('STALE_REVISION');
      if (input.enabled && !this.available) throw new Error('PUSH_UNAVAILABLE');
      if (input.enabled && !DateTime.now().setZone(status.timezone).isValid) throw new Error('INVALID_DIGEST_TIME');
      this.db.prepare('INSERT INTO digest_settings (member_id, enabled, local_time, revision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET enabled = excluded.enabled, local_time = excluded.local_time, revision = excluded.revision, updated_at = excluded.updated_at').run(actor.memberId, Number(input.enabled), input.localTime, status.revision + 1, this.clock().toISOString());
      return this.status(actor);
    })();
  }
  async deliverDue() {
    if (!this.available) return { sent: 0 };
    const now = this.clock(); const timestamp = now.toISOString();
    const settings = this.db.prepare('SELECT s.*, m.household_id, m.timezone FROM digest_settings s JOIN members m ON m.id = s.member_id WHERE s.enabled = 1 AND m.active = 1').all() as Array<Settings & { member_id: string; household_id: string; timezone: string }>;
    let sent = 0;
    for (const setting of settings) {
      const local = DateTime.fromJSDate(now).setZone(setting.timezone);
      if (!local.isValid) continue;
      const date = local.toISODate()!;
      // Resolve each local day independently so DST never shifts the configured hour.
      const due = DateTime.fromISO(`${date}T${setting.local_time}`, { zone: setting.timezone }).getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0];
      if (!due?.isValid) continue;
      const expiry = DateTime.min(due.plus({ hours: 4 }), local.plus({ days: 1 }).startOf('day'));
      if (local < due || local >= expiry) continue;
      this.db.prepare('INSERT OR IGNORE INTO digest_days (member_id, local_date, settings_revision, expires_at) VALUES (?, ?, ?, ?)').run(setting.member_id, date, setting.revision, expiry.toUTC().toISO());
      const day = this.db.prepare('SELECT settings_revision, expires_at FROM digest_days WHERE member_id = ? AND local_date = ?').get(setting.member_id, date) as { settings_revision: number; expires_at: string };
      if (day.settings_revision !== setting.revision || day.expires_at <= timestamp) continue;
      const subs = this.db.prepare("SELECT id FROM push_subscriptions WHERE member_id = ? AND status = 'enabled'").all(setting.member_id) as Array<{ id: string }>;
      for (const sub of subs) {
        const liveNow = this.clock(); const liveTime = liveNow.toISOString();
        const recipient = this.db.prepare("SELECT ps.encrypted_endpoint, ps.encrypted_keys FROM push_subscriptions ps JOIN members m ON m.id = ps.member_id JOIN digest_settings s ON s.member_id = m.id WHERE ps.id = ? AND ps.member_id = ? AND ps.status = 'enabled' AND m.active = 1 AND m.household_id = ? AND m.timezone = ? AND s.enabled = 1 AND s.revision = ?").get(sub.id, setting.member_id, setting.household_id, setting.timezone, setting.revision) as { encrypted_endpoint: string; encrypted_keys: string } | undefined;
        if (!recipient || liveTime >= day.expires_at) continue;
        const claim = this.db.transaction(() => {
          const old = this.db.prepare('SELECT state, attempts, next_attempt_at, updated_at FROM digest_deliveries WHERE member_id = ? AND local_date = ? AND subscription_id = ?').get(setting.member_id, date, sub.id) as { state: string; attempts: number; next_attempt_at: string; updated_at: string } | undefined;
          if (old && (['accepted','expired'].includes(old.state) || old.attempts >= 3 || old.next_attempt_at > liveTime || old.state === 'pending' && Date.parse(old.updated_at) > liveNow.getTime() - 60000)) return 0;
          if (old) this.db.prepare("UPDATE digest_deliveries SET state = 'pending', attempts = attempts + 1, updated_at = ? WHERE member_id = ? AND local_date = ? AND subscription_id = ?").run(liveTime, setting.member_id, date, sub.id);
          else this.db.prepare("INSERT INTO digest_deliveries (member_id, local_date, subscription_id, state, next_attempt_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(setting.member_id, date, sub.id, liveTime, liveTime);
          return (old?.attempts ?? 0) + 1;
        })();
        if (!claim) continue;
        let result: 'accepted' | 'gone' | 'retry' = 'retry';
        try {
          const endpoint = decryptJson<string>(JSON.parse(recipient.encrypted_endpoint) as Envelope, this.key, `push-endpoint:${sub.id}`);
          const keys = decryptJson<{ p256dh: string; auth: string }>(JSON.parse(recipient.encrypted_keys) as Envelope, this.key, `push-keys:${sub.id}`);
          result = await this.push.send({ id: sub.id, endpoint, ...keys, label: '' }, { title: 'Fridgedoor morning brief', url: '/dashboard/', tag: `digest-${setting.member_id}-${date}` }, Math.max(1, Math.floor((Date.parse(day.expires_at) - liveNow.getTime()) / 1000)));
        } catch { /* Durable retries contain no endpoint or private content. */ }
        const finished = this.clock();
        if (result === 'gone') this.db.prepare("UPDATE push_subscriptions SET status = 'disabled', updated_at = ? WHERE id = ? AND encrypted_endpoint = ? AND encrypted_keys = ?").run(finished.toISOString(), sub.id, recipient.encrypted_endpoint, recipient.encrypted_keys);
        this.db.prepare('UPDATE digest_deliveries SET state = ?, next_attempt_at = ?, updated_at = ? WHERE member_id = ? AND local_date = ? AND subscription_id = ? AND attempts = ?').run(result === 'accepted' ? 'accepted' : result === 'gone' ? 'expired' : 'uncertain', new Date(finished.getTime() + claim * 60000).toISOString(), finished.toISOString(), setting.member_id, date, sub.id, claim);
        if (result === 'accepted') sent++;
      }
    }
    return { sent };
  }
}
