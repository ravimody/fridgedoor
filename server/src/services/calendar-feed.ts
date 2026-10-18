import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import type { PlanSummary } from '@fridgedoor/contracts';
import { digest } from '../crypto.js';
import type { PlanRepository } from '../repos/plans.js';

type Clock = () => Date;
const WINDOW_PAST_DAYS = 60;
const WINDOW_FUTURE_DAYS = 400;

/**
 * A calendar subscription (webcal) for one member: their household's shared plans and
 * their own private ones, once saved or added. Works with Apple, Google and Outlook
 * calendars without connecting any account.
 */
export class CalendarFeedService {
  constructor(private readonly db: Database.Database, private readonly plans: PlanRepository, private readonly clock: Clock = () => new Date()) {}

  /** Replaces any existing link: the old URL stops working. */
  create(memberId: string) {
    const token = randomBytes(24).toString('base64url'); const now = this.clock().toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE calendar_feeds SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(now, memberId);
      this.db.prepare('INSERT INTO calendar_feeds (id, member_id, token_digest, created_at) VALUES (?, ?, ?, ?)').run(randomBytes(16).toString('hex'), memberId, digest(token), now);
    })();
    return token;
  }

  status(memberId: string) {
    const row = this.db.prepare('SELECT created_at as createdAt, last_fetched_at as lastFetchedAt FROM calendar_feeds WHERE member_id = ? AND revoked_at IS NULL').get(memberId) as { createdAt: string; lastFetchedAt: string | null } | undefined;
    return { active: Boolean(row), createdAt: row?.createdAt ?? null, lastFetchedAt: row?.lastFetchedAt ?? null };
  }

  revoke(memberId: string) { this.db.prepare('UPDATE calendar_feeds SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(this.clock().toISOString(), memberId); return { active: false }; }

  /** The iCalendar body for a feed token, or null when the link is unknown or revoked. */
  render(token: string, origin: string, calendarName: string): string | null {
    const row = this.db.prepare('SELECT f.id, f.member_id as memberId FROM calendar_feeds f JOIN members m ON m.id = f.member_id AND m.active = 1 WHERE f.token_digest = ? AND f.revoked_at IS NULL').get(digest(token)) as { id: string; memberId: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE calendar_feeds SET last_fetched_at = ? WHERE id = ?').run(this.clock().toISOString(), row.id);
    const now = DateTime.fromJSDate(this.clock());
    const from = now.minus({ days: WINDOW_PAST_DAYS }).toMillis(); const to = now.plus({ days: WINDOW_FUTURE_DAYS }).toMillis();
    const events = this.plans.list(row.memberId).filter((plan) => plan.status === 'accepted' || plan.savedInPlanner)
      .map((plan) => eventFor(plan, origin)).filter((event): event is { start: number; lines: string[] } => Boolean(event) && event!.start >= from && event!.start <= to);
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fridgedoor//Household planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${text(calendarName)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
      ...events.flatMap((event) => event.lines), 'END:VCALENDAR',
    ].map(fold).join('\r\n') + '\r\n';
  }
}

const utc = (iso: string) => DateTime.fromISO(iso, { setZone: true }).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
const day = (date: string) => date.replaceAll('-', '');
/** RFC 5545 text escaping. */
// eslint-disable-next-line no-control-regex
const text = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line: string) {
  const bytes = Buffer.from(line, 'utf8'); if (bytes.length <= 75) return line;
  const parts: string[] = []; let current = '';
  for (const char of line) { if (Buffer.byteLength(current + char, 'utf8') > (parts.length ? 74 : 75)) { parts.push(current); current = ''; } current += char; }
  parts.push(current);
  return parts.join('\r\n ');
}

function eventFor(plan: PlanSummary, origin: string): { start: number; lines: string[] } | null {
  const time = plan.facts.time; if (!time) return null;
  let start: number; let when: string[];
  if (time.kind === 'timed') { start = Date.parse(time.start); when = [`DTSTART:${utc(time.start)}`, `DTEND:${utc(time.end)}`]; }
  else if (time.kind === 'all_day') { start = Date.parse(`${time.startDate}T00:00:00Z`); when = [`DTSTART;VALUE=DATE:${day(time.startDate)}`, `DTEND;VALUE=DATE:${day(time.endDateExclusive)}`]; }
  else if (time.kind === 'deadline') { start = Date.parse(time.at); when = [`DTSTART:${utc(time.at)}`, `DTEND:${utc(DateTime.fromISO(time.at, { setZone: true }).plus({ minutes: 15 }).toISO()!)}`]; }
  else return null;
  const title = time.kind === 'deadline' ? `Due: ${plan.facts.title}` : plan.facts.title;
  const link = `${origin}/dashboard/plans/${plan.id}`;
  const description = [plan.facts.notes, ...(plan.facts.preparationTasks.length ? ['To prepare:', ...plan.facts.preparationTasks.map((task) => `• ${task}`)] : []), `Open in Fridgedoor: ${link}`].filter(Boolean).join('\n');
  return { start, lines: [
    'BEGIN:VEVENT', `UID:${plan.id}@fridgedoor`, `DTSTAMP:${utc(plan.updatedAt)}`, `SEQUENCE:${plan.revision}`, ...when,
    `SUMMARY:${text(title)}`, ...(plan.facts.location ? [`LOCATION:${text(plan.facts.location)}`] : []), `DESCRIPTION:${text(description)}`, `URL:${link}`,
    ...(plan.visibility === 'private' ? ['CLASS:PRIVATE'] : []), 'STATUS:CONFIRMED', 'END:VEVENT',
  ] };
}
