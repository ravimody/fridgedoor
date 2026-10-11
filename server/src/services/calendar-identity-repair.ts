import type Database from 'better-sqlite3';
import { decryptJson, encryptJson, indexKey } from '../crypto.js';
import type { GoogleProvider } from '../providers/google.js';
import { GoogleTokenService } from './google-tokens.js';

/** Repair only authenticated legacy envelopes; never change selections or grants. */
export async function repairCalendarIdentities(db: Database.Database, key: Buffer, provider: GoogleProvider) {
  const connections = db.prepare("SELECT gc.id, gc.generation FROM google_connections gc JOIN members m ON m.id = gc.member_id WHERE gc.status = 'active' AND m.active = 1").all() as { id: string; generation: number }[];
  let repaired = 0;
  for (const connection of connections) {
    const grant = await new GoogleTokenService(db, key, provider).grant(connection.id, connection.generation);
    const calendars = await provider.listCalendars(grant);
    db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM google_connections gc JOIN members m ON m.id = gc.member_id WHERE gc.id = ? AND gc.generation = ? AND gc.status = 'active' AND m.active = 1").get(connection.id, connection.generation)) throw new Error('GOOGLE_CONNECTION_CHANGED');
      for (const calendar of calendars) {
        const calendarKey = indexKey(calendar.id, key);
        const row = db.prepare('SELECT id, encrypted_calendar_id FROM calendar_selections WHERE connection_id = ? AND generation = ? AND calendar_key = ?').get(connection.id, connection.generation, calendarKey) as { id: string; encrypted_calendar_id: string } | undefined;
        if (!row) continue;
        const envelope = JSON.parse(row.encrypted_calendar_id);
        const context = `calendar:${connection.id}:${calendarKey}`;
        try { if (decryptJson<{ id: string }>(envelope, key, context).id === calendar.id) continue; } catch { /* Verify the legacy context before re-encrypting. */ }
        const legacy = decryptJson<{ id: string }>(envelope, key, `calendar:${connection.id}:${calendar.id}`);
        if (legacy.id !== calendar.id) throw new Error('CALENDAR_IDENTITY_MISMATCH');
        db.prepare('UPDATE calendar_selections SET encrypted_calendar_id = ? WHERE id = ?').run(JSON.stringify(encryptJson(legacy, key, context)), row.id);
        repaired += 1;
      }
    })();
  }
  return { repaired };
}
