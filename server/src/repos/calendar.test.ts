import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { encryptJson, keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import { CalendarRepository, type CalendarEventPayload } from './calendar.js';

describe('calendar agenda authorization', () => {
  it('shows a partner only shared eligible events and keeps private overlays owner-scoped', () => {
    const db = new Database(':memory:'); migrate(db); const now = new Date().toISOString(); const key = keyFromSecret('secret');
    db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run('h1', now); for (const [id, name] of [['m1', 'Alex'], ['m2', 'Sam']]) db.prepare('INSERT INTO members (id, household_id, access_subject, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'h1', id, name, 'America/New_York', 1, now);
    const insertConnection = (id: string, member: string, sub: string) => db.prepare('INSERT INTO google_connections (id, member_id, google_sub, email, grants_json, encrypted_tokens, status, generation, disclosure_version, consented_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, member, sub, `${member}@example.test`, '[]', '{}', 'active', 1, 'v1', now, now, now);
    insertConnection('c1', 'm1', 'g1'); insertConnection('c2', 'm2', 'g2'); const insertSelection = (id: string, connection: string, owner: string, classification: string) => db.prepare('INSERT INTO calendar_selections (id, connection_id, generation, encrypted_calendar_id, calendar_key, selected, classification, provider_access_role, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, connection, 1, JSON.stringify(encryptJson({ id }, key, `calendar:${connection}:${id}`)), id, 1, classification, 'owner', id);
    insertSelection('s1', 'c1', 'm1', 'personal'); insertSelection('s2', 'c2', 'm2', 'household');
    const payload = (visibility: CalendarEventPayload['visibility'], title: string): CalendarEventPayload => ({ providerEventId: title, summary: title, normalizedTime: { kind: 'all_day', startDate: '2026-01-01', endDateExclusive: '2026-01-02' }, visibility });
    const insertOccurrence = (id: string, source: string, selection: string, owner: string, value: CalendarEventPayload) => { db.prepare("INSERT INTO source_items (id, household_id, owner_id, connection_id, kind, provider_key, encrypted_provider_refs, state, generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'calendar_event', ?, '{}', 'available', 1, ?, ?)").run(source, 'h1', owner, owner === 'm1' ? 'c1' : 'c2', `${id}-key`, now, now); db.prepare('INSERT INTO calendar_occurrences (id, source_id, calendar_selection_id, occurrence_key, provider_event_key, normalized_time_json, encrypted_payload, status, visibility, generation, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, source, selection, `${id}-occ`, `${id}-event`, JSON.stringify(value.normalizedTime), JSON.stringify(encryptJson(value, key, `calendar-occurrence:${id}`)), 'confirmed', value.visibility, 1, '2030-01-01T00:00:00.000Z', now, now); };
    insertOccurrence('private', 'source-private', 's1', 'm1', payload('owner', 'private')); insertOccurrence('shared', 'source-shared', 's2', 'm2', payload('shared_eligible', 'shared'));
    const repo = new CalendarRepository(db, key, () => new Date('2026-01-01T00:00:00.000Z')); const agenda = repo.agenda({ memberId: 'm2', householdId: 'h1' }); expect(agenda.map((value) => value.summary)).toEqual(['shared']);
    const partner = { memberId: 'm1', householdId: 'h1' };
    expect(repo.agenda(partner).map((value) => value.summary)).toEqual(['private', 'shared']);
    // Invalid ciphertext proves revoked/stale rows are filtered before decryption.
    db.prepare("UPDATE calendar_occurrences SET encrypted_payload = 'unreadable' WHERE id = 'shared'").run();
    db.prepare("UPDATE members SET active = 0 WHERE id = 'm2'").run();
    expect(repo.agenda(partner).map((value) => value.summary)).toEqual(['private']);
    db.prepare("UPDATE members SET active = 1 WHERE id = 'm2'").run();
    db.prepare("UPDATE google_connections SET generation = 2 WHERE id = 'c2'").run();
    expect(repo.agenda(partner).map((value) => value.summary)).toEqual(['private']);
    expect(repo.agendaSafe(partner).map((value) => value.title)).toEqual(['private']);
    db.prepare("UPDATE calendar_selections SET generation = 2 WHERE id = 's2'").run();
    expect(repo.agenda(partner).map((value) => value.summary)).toEqual(['private']);
  });
});
