/**
 * Loopback-only synthetic preview server for developing the native iOS client
 * against the real HTTP handlers. It seeds an obviously fake household relative
 * to today (America/New_York), runs the job worker in-process with deterministic
 * fake providers, and blocks every outbound network request.
 *
 * Usage: pnpm --filter @fridgedoor/server dev:native [-- --reset]
 * Env:   PORT (default 8899), PREVIEW_DB (reuse a file), PREVIEW_MEMBER=alex|sam
 *
 * Synthetic development data only. Never point this at a real Fridgedoor database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { DateTime } from 'luxon';
import type { AssistantResult, DailyOverview, NormalizedTime, PlanFacts, TrialSummary } from '@fridgedoor/contracts';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { keyFromSecret } from '../crypto.js';
import { migrate } from '../db/migrate.js';
import type { MemberRecord } from '../auth/access.js';
import { SessionStore } from '../auth/session.js';
import { FakeGoogleProvider, GOOGLE_SCOPES, type GoogleCalendar, type GoogleEvent, type GoogleEventWrite, type GoogleGrant } from '../providers/google.js';
import { FakePushProvider } from '../providers/push.js';
import { ConnectionService } from '../services/connections.js';
import { PlanRepository } from '../repos/plans.js';
import { SourceRepository } from '../repos/sources.js';
import { CalendarRepository } from '../repos/calendar.js';
import { KnowledgeRepository } from '../repos/knowledge.js';
import { JobQueue } from '../jobs/queue.js';
import { Scheduler } from '../jobs/scheduler.js';
import { Worker } from '../jobs/worker.js';
import { GmailSync } from '../sync/gmail.js';
import { CalendarSync } from '../sync/calendar.js';
import { CalendarActionService } from '../services/calendar-actions.js';
import { PlanDecisionService } from '../services/plan-decisions.js';
import { ListService } from '../services/lists.js';
import { ReminderService } from '../services/reminders.js';
import { MorningDigestService } from '../services/morning-digest.js';
import { BackgroundAiService } from '../services/background-ai.js';
import { ActivityNotificationService } from '../services/activity-notifications.js';
import { DAILY_AI_CONSENT, DailyOverviewService } from '../services/daily-overview.js';
import { KnowledgeMaintenanceService } from '../services/knowledge-maintenance.js';
import { RelevanceTrialService } from '../services/relevance-trial.js';
import type { DailyContext, DailyCandidate } from '../services/daily-context.js';
import { AssistantService } from '../ai/assistant-service.js';
import type { AgentMetrics, AgentPacket, AgentProvider } from '../ai/agent.js';
import { categoryFor, type DailyOverviewProvider, type DailyOverviewResponse } from '../ai/daily-overview.js';
import type { KnowledgeMaintenanceProvider } from '../ai/knowledge-maintenance.js';
import type { TrialSummaryInput, TrialSummaryProvider } from '../ai/relevance-summary.js';
import { staticHub } from '../llm/hub.js';
import { llmError, type GenerateRequest, type GenerateResult, type LlmProvider } from '../llm/types.js';

// ---------------------------------------------------------------------------
// Guard rails and configuration
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV === 'production') {
  console.error('native-preview: refusing to start with NODE_ENV=production. This server only serves synthetic data.');
  process.exit(1);
}

const ZONE = 'America/New_York';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8899);
const ORIGIN = `http://${HOST}:${PORT}`;
// Stable so an existing PREVIEW_DB stays decryptable across restarts. Not a real secret.
const PREVIEW_SECRET = 'preview-only-synthetic-session-secret-not-for-production';
const CHAT_MODEL = 'preview-synthetic-chat';
const HOUSEHOLD_ID = 'preview-household';
const HOUSEHOLD_CALENDAR = 'household.preview@group.calendar.example.com';
const PERSONAL_CALENDAR = 'alex.preview@example.com';
const GOOGLE_CODE = 'preview-google-consent-code';
const MEMBERS = {
  alex: { id: 'preview-member-alex', accessSubject: 'preview-subject-alex', allowedEmail: 'alex@example.com', displayName: 'Alex' },
  sam: { id: 'preview-member-sam', accessSubject: 'preview-subject-sam', allowedEmail: 'sam@example.com', displayName: 'Sam' },
} as const;
type MemberKey = keyof typeof MEMBERS;
type Actor = { memberId: string; householdId: string };

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) { console.error(`native-preview: invalid PORT ${process.env.PORT}`); process.exit(1); }
const signedIn = (process.env.PREVIEW_MEMBER ?? 'alex').toLowerCase();
if (signedIn !== 'alex' && signedIn !== 'sam') { console.error('native-preview: PREVIEW_MEMBER must be "alex" or "sam".'); process.exit(1); }
const reset = process.argv.includes('--reset');

const tempDir = process.env.PREVIEW_DB ? undefined : mkdtempSync(join(tmpdir(), 'fridgedoor-preview-'));
const dbPath = process.env.PREVIEW_DB ? resolve(process.env.PREVIEW_DB) : join(tempDir!, 'fridgedoor-preview.sqlite');
if (reset) for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
const reuse = existsSync(dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

// AI runs on the synthetic `previewLlm` below, so no AI settings come from the environment.
const config = loadConfig({
  NODE_ENV: 'development', DATABASE_PATH: dbPath, SESSION_SECRET: PREVIEW_SECRET, APP_ORIGIN: ORIGIN, PUSH_PROVIDER: 'fake',
  ASSISTANT_ENABLED: 'true', AI_ENABLED: 'true',
});

// ---------------------------------------------------------------------------
// Time helpers (relative to today in America/New_York)
// ---------------------------------------------------------------------------
const today = () => DateTime.now().setZone(ZONE).startOf('day');
const at = (day: number, hhmm: string) => { const [hour = 0, minute = 0] = hhmm.split(':').map(Number); return today().plus({ days: day }).set({ hour, minute }); };
const iso = (value: DateTime) => value.toISO({ suppressMilliseconds: true })!;
const localDate = (day: number) => today().plus({ days: day }).toISODate()!;
const timed = (day: number, start: string, end: string): NormalizedTime => ({ kind: 'timed', start: iso(at(day, start)), end: iso(at(day, end)), timezone: ZONE });
const allDay = (day: number, days = 1): NormalizedTime => ({ kind: 'all_day', startDate: localDate(day), endDateExclusive: localDate(day + days) });
const deadline = (day: number, hhmm: string): NormalizedTime => ({ kind: 'deadline', at: iso(at(day, hhmm)), timezone: ZONE });
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done, fail) => { const timer = setTimeout(done, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('AGENT_TIMEOUT')); }, { once: true }); });

// ---------------------------------------------------------------------------
// Network guard: nothing leaves the machine. The app's AI paths use the
// synthetic `previewLlm` model, never a real provider.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
  throw new TypeError(`native-preview blocked an outbound request to ${url.hostname}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Synthetic Google: two calendars whose events move with "today", plus writes
// that persist in a preview-only table so Apply survives restarts.
// ---------------------------------------------------------------------------
type EventExtra = Partial<Pick<GoogleEvent, 'location' | 'description' | 'status'>>;
const googleTimed = (id: string, summary: string, day: number, start: string, end: string, extra: EventExtra = {}): GoogleEvent => ({ id, iCalUID: `${id}@preview.example.com`, summary, status: 'confirmed', start: { dateTime: iso(at(day, start)), timeZone: ZONE }, end: { dateTime: iso(at(day, end)), timeZone: ZONE }, ...extra });
const googleAllDay = (id: string, summary: string, day: number, days = 1, extra: EventExtra = {}): GoogleEvent => ({ id, iCalUID: `${id}@preview.example.com`, summary, status: 'confirmed', start: { date: localDate(day) }, end: { date: localDate(day + days) }, ...extra });
function calendarFixtures(calendarId: string): GoogleEvent[] {
  if (calendarId === HOUSEHOLD_CALENDAR) return [
    googleAllDay('preview-hh-recycling', 'Recycling pickup', 0),
    googleTimed('preview-hh-dropoff', 'School drop-off (Alex)', 0, '07:45', '08:15', { location: 'Brookside Elementary' }),
    googleTimed('preview-hh-plumber', 'Plumber visit window', 0, '13:00', '15:00', { status: 'tentative', location: 'Home' }),
    googleTimed('preview-hh-gym', 'Gymnastics at the rec center', 1, '09:30', '10:30', { location: 'Riverside Rec Center, 200 Example Rd' }),
    googleTimed('preview-hh-bookclub', 'Book club at the Parkers’', 2, '19:00', '21:00', { status: 'tentative', location: '18 Example Ln' }),
    googleAllDay('preview-hh-grandparents', 'Grandparents visiting', 3, 4),
    googleTimed('preview-hh-art', 'Art class', 4, '16:00', '17:00', { location: 'Community art studio, 9 Example Ct' }),
    googleAllDay('preview-hh-closed', 'No school — teacher planning day', 5),
    googleTimed('preview-hh-haircuts', 'Haircuts for the kids', 6, '10:00', '11:00', { location: 'Snip Shop, 77 Example Ave' }),
    googleTimed('preview-hh-eye', 'Eye exam', 8, '09:00', '09:45', { location: 'Example Eye Care' }),
  ];
  if (calendarId === PERSONAL_CALENDAR) return [
    googleTimed('preview-alex-gym', 'Gym — strength class', 0, '06:30', '07:15'),
    googleTimed('preview-alex-lunch', 'Lunch with a former colleague', 1, '12:30', '13:30', { location: 'Corner Café' }),
    googleTimed('preview-alex-call', 'Insurance call (tentative)', 2, '08:00', '08:30', { status: 'tentative' }),
    googleAllDay('preview-alex-conference', 'Remote conference', 3),
  ];
  return [];
}

class PreviewGoogleProvider extends FakeGoogleProvider {
  onWrite: (() => void) | undefined;
  constructor(private readonly store: Database.Database, grants: Record<string, GoogleGrant>) {
    super(grants);
    store.exec('CREATE TABLE IF NOT EXISTS preview_google_events (calendar_id TEXT NOT NULL, event_id TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (calendar_id, event_id))');
  }
  private stored(calendarId: string) { return (this.store.prepare('SELECT event_json FROM preview_google_events WHERE calendar_id = ?').all(calendarId) as Array<{ event_json: string }>).map((row) => JSON.parse(row.event_json) as GoogleEvent); }
  private save<T extends GoogleEvent & { etag: string }>(calendarId: string, event: T): T { this.store.prepare('INSERT INTO preview_google_events VALUES (?, ?, ?) ON CONFLICT(calendar_id, event_id) DO UPDATE SET event_json = excluded.event_json').run(calendarId, event.id, JSON.stringify(event)); this.onWrite?.(); return event; }
  override async listCalendars(): Promise<GoogleCalendar[]> { return [{ id: HOUSEHOLD_CALENDAR, summary: 'Family', accessRole: 'owner' }, { id: PERSONAL_CALENDAR, summary: 'Alex (personal)', accessRole: 'owner', primary: true }]; }
  override async listCalendarEvents(_grant: GoogleGrant, calendarId: string) { return { items: [...calendarFixtures(calendarId), ...this.stored(calendarId)], nextSyncToken: `preview-sync-${Date.now()}` }; }
  override async listCalendarInstances() { return { items: [] }; }
  override async getCalendarEvent(_grant: GoogleGrant, calendarId: string, eventId: string) { return this.stored(calendarId).find((event) => event.id === eventId) ?? null; }
  override async createCalendarEvent(_grant: GoogleGrant, calendarId: string, eventId: string, input: GoogleEventWrite) { return this.save(calendarId, { id: eventId, status: 'confirmed', ...input, etag: `"preview-${randomBytes(6).toString('hex')}"` }); }
  override async updateCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, input: GoogleEventWrite, etag?: string) {
    const current = await this.getCalendarEvent(grant, calendarId, eventId);
    if (!current) throw new Error('GOOGLE_CALENDAR_NOT_FOUND');
    if (etag && current.etag !== etag) throw new Error('GOOGLE_CALENDAR_CONFLICT');
    return this.save(calendarId, { ...current, ...input, etag: `"preview-${randomBytes(6).toString('hex')}"` });
  }
  override async deleteCalendarEvent(grant: GoogleGrant, calendarId: string, eventId: string, etag?: string) {
    const current = await this.getCalendarEvent(grant, calendarId, eventId);
    if (!current) return;
    if (etag && current.etag !== etag) throw new Error('GOOGLE_CALENDAR_CONFLICT');
    this.save(calendarId, { ...current, etag: current.etag ?? '"preview-cancelled"', status: 'cancelled' });
  }
}

// ---------------------------------------------------------------------------
// Deterministic assistant: pattern-matches simple grocery / to-do / event /
// "remember" / question phrasing and returns a schema-valid proposal.
// ---------------------------------------------------------------------------
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const QUANTITY = /^((?:a|one|\d+(?:\.\d+)?)\s*(?:lbs?|pounds?|oz|kg|dozen|gallons?|bags?|boxes?|cans?|bunch(?:es)?|packs?|bottles?|cartons?|loaf|loaves)?)\s+(?:of\s+)?(.+)$/i;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').split('_').slice(0, 4).join('_') || 'household_note';
const splitList = (value: string) => value.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map((part) => part.trim().replace(/^(?:some|more)\s+/i, '')).filter(Boolean);
function dateIn(text: string, reference: DateTime): DateTime | undefined {
  const lower = text.toLowerCase();
  if (/\b(today|tonight|this evening)\b/.test(lower)) return reference.startOf('day');
  if (/\btomorrow\b/.test(lower)) return reference.startOf('day').plus({ days: 1 });
  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`).test(lower));
  if (weekday < 0) return undefined;
  const days = (weekday + 1 - reference.weekday + 7) % 7;
  return reference.startOf('day').plus({ days: days === 0 ? 7 : days });
}
function timeIn(text: string): { hour: number; minute: number } | undefined {
  if (/\bnoon\b/i.test(text)) return { hour: 12, minute: 0 };
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return undefined;
  const hour = Number(match[1]) % 12 + (match[3]!.toLowerCase() === 'pm' ? 12 : 0);
  return { hour, minute: Number(match[2] ?? 0) };
}
const stripScheduling = (text: string) => text
  .replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:at\s+)?noon\b/gi, ' ')
  .replace(/\b(?:on\s+|this\s+|next\s+)?(?:today|tonight|tomorrow|this evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, ' ')
  .replace(/\b(?:at|in|@)\s+(?:the\s+)?[A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*)*/g, ' ')
  .replace(/^(?:please\s+)?(?:schedule|add|put|book|plan|create)\s+(?:an?\s+)?/i, '')
  .replace(/\b(?:to|on)\s+(?:the\s+|our\s+)?calendar\b/gi, ' ')
  .replace(/\s+/g, ' ').trim().replace(/[.,;:!]+$/, '');

class PreviewAgent implements AgentProvider {
  async run(packet: AgentPacket, context: () => unknown, signal: AbortSignal): Promise<{ result: AssistantResult; metrics: AgentMetrics }> {
    const started = Date.now();
    await sleep(1200, signal); // Long enough for the app to show the queued/running states.
    if (/docs\.google\.com|\bfail\b/i.test(packet.text)) throw new Error('AGENT_PROVIDER_FAILED');
    const reference = DateTime.fromISO(packet.referenceTime, { zone: 'utc' }).setZone(packet.timezone);
    const tools: string[] = []; const items: AssistantResult['items'] = []; const knowledge: AssistantResult['knowledge'] = [];
    const assumptions: string[] = []; const followups: string[] = []; const replies: string[] = [];
    const clauses = packet.text.split(/[\n;]+|\.\s+|\s+and\s+(?=(?:also\s+)?(?:remind me|add|buy|put|schedule|remember)\b)/i).map((part) => part.trim().replace(/\.$/, '')).filter(Boolean);
    for (const clause of clauses) {
      const remember = clause.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i);
      const todo = clause.match(/^(?:also\s+)?(?:please\s+)?(?:remind me to|i need to|don'?t forget to|to-?do:?)\s+(.+)$/i) ?? clause.match(/^(?:please\s+)?add\s+(.+?)\s+to\s+(?:my\s+|the\s+|our\s+)?(?:to-?dos?|tasks?)(?:\s+list)?$/i);
      const grocery = clause.match(/^(?:also\s+)?(?:please\s+)?(?:add|put|buy|get|we need|we're out of|we are out of)\s+(.+?)(?:\s+(?:to|on)\s+(?:the\s+|our\s+|my\s+)?(?:grocery|groceries|shopping)(?:\s+list)?)?$/i);
      const time = timeIn(clause); const day = dateIn(clause, reference);
      const question = /\?$/.test(clause) || /^(?:what|when|where|who|how|is|are|do|does|did|can|which)\b/i.test(clause);
      if (question) {
        tools.push('household_context');
        const household = context() as { agenda: Array<{ title: string; time: NormalizedTime }>; plans: Array<{ facts: PlanFacts; status: string }>; groceries: Array<{ title: string }>; todos: Array<{ title: string }> };
        const describe = (item: { title: string; time?: NormalizedTime | undefined }) => `${item.title}${item.time?.kind === 'timed' ? ` (${DateTime.fromISO(item.time.start).setZone(packet.timezone).toFormat('ccc h:mm a')})` : item.time?.kind === 'all_day' ? ` (${DateTime.fromISO(item.time.startDate).toFormat('ccc')}, all day)` : ''}`;
        if (/grocer|shopping/i.test(clause)) replies.push(household.groceries.length ? `Open grocery items: ${household.groceries.map((item) => item.title).join(', ')}.` : 'The grocery list is empty.');
        else if (/to-?do|task/i.test(clause)) replies.push(household.todos.length ? `Open to-dos: ${household.todos.map((item) => item.title).join(', ')}.` : 'No open to-dos.');
        else {
          const words = clause.toLowerCase().match(/[a-z]{4,}/g)?.filter((word) => !['what', 'when', 'where', 'does', 'have', 'there', 'today', 'this', 'that', 'with', 'calendar', 'week', "what's"].includes(word)) ?? [];
          const hits = [...household.agenda, ...household.plans.map((plan) => ({ title: plan.facts.title, time: plan.facts.time }))].filter((item) => words.some((word) => item.title.toLowerCase().includes(word)));
          const todays = household.agenda.filter((item) => item.time.kind === 'all_day' ? item.time.startDate <= reference.toISODate()! && item.time.endDateExclusive > reference.toISODate()! : item.time.kind === 'timed' && DateTime.fromISO(item.time.start).setZone(packet.timezone).hasSame(reference, 'day'));
          replies.push(hits.length ? `Here's what I found: ${hits.slice(0, 4).map(describe).join('; ')}.` : `Today's calendar has ${todays.length} item${todays.length === 1 ? '' : 's'}${todays.length ? `: ${todays.slice(0, 6).map(describe).join('; ')}` : ''}.`);
        }
      } else if (remember) {
        const fact = remember[1]!.trim();
        const subject = fact.match(/^(.+?)\s+(?:is|are|happens?)\s+/i)?.[1] ?? fact;
        knowledge.push({ operation: 'set', key: slug(subject.replace(/^(?:the|our|my)\s+/i, '')), value: capitalize(fact).slice(0, 500) });
        replies.push('I can save that to household memory once you confirm.');
      } else if (todo) {
        const due = dateIn(todo[1]!, reference);
        const title = capitalize(stripScheduling(todo[1]!.replace(/\bby\s+(?=\w)/i, '')) || todo[1]!);
        items.push({ intent: 'direct', kind: 'todo', title: title.slice(0, 200), quantity: null, start: due ? iso(due.set({ hour: 9 })) : null, end: null, location: null, notes: null });
        replies.push(`I'll add “${title}” to your to-dos${due ? ` for ${due.toFormat('cccc')}` : ''}.`);
      } else if (grocery && (/grocer|shopping/i.test(clause) || !(time || day))) {
        const names = splitList(grocery[1]!);
        for (const name of names) {
          const quantity = name.match(QUANTITY);
          items.push({ intent: 'direct', kind: 'grocery', title: capitalize((quantity?.[2] ?? name).trim()).slice(0, 200), quantity: quantity ? quantity[1]!.replace(/^(?:a|one)\s*/i, '1 ').trim() : null, start: null, end: null, location: null, notes: null });
        }
        replies.push(`I'll add ${names.length} item${names.length === 1 ? '' : 's'} to groceries: ${names.join(', ')}.`);
      } else if (time || day) {
        const start = (day ?? (time && reference.set({ hour: time.hour, minute: time.minute }) > reference ? reference.startOf('day') : reference.startOf('day').plus({ days: 1 }))).set(time ? { hour: time.hour, minute: time.minute } : {});
        const hours = /dinner|party|book club|game/i.test(clause) ? 2 : 1;
        const location = clause.match(/\b(?:at|@)\s+((?:the\s+)?[A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*)*)/)?.[1] ?? null;
        const title = capitalize(stripScheduling(clause) || 'Household event');
        items.push({ intent: 'proposal', kind: 'event', title: title.slice(0, 200), quantity: null, start: time ? iso(start) : null, end: time ? iso(start.plus({ hours })) : null, location, notes: null });
        if (time) assumptions.push(`Assumed ${hours} hour${hours === 1 ? '' : 's'} since no end time was given: ${title}`.slice(0, 300));
        else followups.push(`What time does “${title}” start?`.slice(0, 300));
        replies.push(`Here's a draft event: ${title}, ${start.toFormat('cccc, LLL d')}${time ? ` at ${start.toFormat('h:mm a')}` : ''}. Review it before adding it to the calendar.`);
      }
    }
    const result: AssistantResult = { reply: (replies.join(' ') || 'I could not find anything to add. Try “add milk to groceries” or “dinner with the Parkers Friday 7pm”.').slice(0, 4000), sources: [], assumptions: assumptions.slice(0, 10), followups: followups.slice(0, 5), items: items.slice(0, 40), knowledge: knowledge.slice(0, 10) };
    return { result, metrics: { model: 'preview-synthetic-agent', promptVersion: 'preview-agent-v1', inputTokens: Math.ceil(JSON.stringify(packet).length / 4), outputTokens: Math.ceil(JSON.stringify(result).length / 4), durationMs: Date.now() - started, tools } };
  }
}

// ---------------------------------------------------------------------------
// Deterministic morning review, knowledge maintenance and trial summary.
// ---------------------------------------------------------------------------
function describeCandidate(candidate: DailyCandidate, context: DailyContext) {
  const time = candidate.normalizedTime; const zone = context.timezone;
  const dayLabel = (value: DateTime) => { const offset = Math.round(value.startOf('day').diff(DateTime.fromISO(context.referenceDate, { zone }).startOf('day'), 'days').days); return offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : value.toFormat('cccc'); };
  const when = !time ? '' : time.kind === 'timed' ? `${dayLabel(DateTime.fromISO(time.start).setZone(zone))}, ${DateTime.fromISO(time.start).setZone(zone).toFormat('h:mm')}–${DateTime.fromISO(time.end).setZone(zone).toFormat('h:mm a')}` : time.kind === 'all_day' ? `All day ${dayLabel(DateTime.fromISO(time.startDate, { zone })).toLowerCase()}` : time.kind === 'deadline' ? `Due ${dayLabel(DateTime.fromISO(time.at).setZone(zone)).toLowerCase()} at ${DateTime.fromISO(time.at).setZone(zone).toFormat('h:mm a')}` : time.dateHint ? `Around ${dayLabel(DateTime.fromISO(time.dateHint, { zone }))}, time not set` : 'Time not set';
  if (candidate.kind === 'calendar') return `${when}${candidate.state === 'tentative' ? ' (tentative)' : ''}.`;
  if (candidate.kind === 'task' && candidate.navigation.kind === 'task') {
    const due = time?.kind === 'all_day' ? time.startDate : time?.kind === 'deadline' ? DateTime.fromISO(time.at).setZone(zone).toISODate() : undefined;
    return `Open to-do${!due ? '' : due < context.referenceDate ? ` · was planned for ${DateTime.fromISO(due, { zone }).toFormat('cccc')}` : due === context.referenceDate ? ' · planned for today' : ` · planned for ${dayLabel(DateTime.fromISO(due, { zone })).toLowerCase()}`}.`;
  }
  if (candidate.kind === 'task') return `Prep for an upcoming plan${when ? ` · ${when.toLowerCase()}` : ''}.`;
  if (candidate.kind === 'reminder') return `Reminder · ${when.replace(/^Due /, '').toLowerCase()}.`;
  const status = candidate.state === 'accepted' ? 'On the household calendar.' : candidate.state === 'needs_details' ? 'Needs a start time before it can go on the calendar.' : (candidate.revision ?? 1) > 1 ? 'Details changed since it was added — review the update.' : 'Not on the calendar yet — review it.';
  return `${when ? `${when}. ` : ''}${status}`.slice(0, 400);
}
const previewDailyOverview: DailyOverviewProvider = {
  async generate(context: DailyContext, signal: AbortSignal): Promise<DailyOverviewResponse> {
    if (signal.aborted) throw new Error('AI_CANCELLED');
    const required = context.candidates.filter((candidate) => candidate.required);
    // Favor plans among optional picks so every category shows up in the preview.
    const optional = context.candidates.filter((candidate) => !candidate.required && candidate.kind !== 'source').sort((a, b) => Number(b.kind === 'plan') - Number(a.kind === 'plan')).slice(0, 10);
    const category = (candidate: DailyCandidate): DailyOverview['items'][number]['category'] => {
      if (candidate.kind === 'plan' && candidate.normalizedTime?.kind === 'deadline') return 'deadline';
      if (candidate.kind === 'plan' && candidate.state === 'proposed' && (candidate.revision ?? 1) > 1) return 'change';
      if (candidate.kind === 'plan' && (candidate.state === 'needs_details' || candidate.normalizedTime?.kind === 'unresolved' || !candidate.normalizedTime)) return 'decision';
      return categoryFor(candidate, context);
    };
    const items = [...required, ...optional].map((candidate) => ({ refs: [candidate.ref], category: category(candidate), headline: candidate.title.slice(0, 100), detail: describeCandidate(candidate, context), priority: candidate.required || candidate.normalizedTime?.kind === 'deadline' ? 'important' as const : 'routine' as const }));
    const unclear = context.candidates.find((candidate) => candidate.kind === 'plan' && (candidate.state === 'needs_details' || candidate.normalizedTime?.kind === 'unresolved'));
    const questions = unclear ? [{ refs: [unclear.ref], text: `What time does “${unclear.title}” start?`.slice(0, 240), reason: 'The email gives a day but no start time, so it cannot go on the calendar yet.' }] : [];
    const todayCount = items.filter((item) => item.category === 'today').length;
    const summary = items.length ? `${todayCount} thing${todayCount === 1 ? '' : 's'} on today, ${items.length - todayCount} coming up${questions.length ? ', and one question for you' : ''}. (Synthetic preview review.)` : 'Nothing needs attention today. (Synthetic preview review.)';
    const result: DailyOverview = { summary, items, questions, omittedRefs: [] };
    return { result, usage: { inputTokens: Math.ceil(JSON.stringify(context).length / 4), outputTokens: Math.ceil(JSON.stringify(result).length / 4) }, provider: 'preview', model: CHAT_MODEL };
  },
};
const previewTrialSummary: TrialSummaryProvider = {
  async summarize(input, previous = []) {
    const useful = input.filter((item) => item.vote === 'useful'); const notUseful = input.filter((item) => item.vote === 'not_useful');
    const preferences: TrialSummary['preferences'] = [];
    if (useful.length) preferences.push({ direction: 'prefer', pattern: `School logistics that need prep, like “${useful[0]!.title}”`.slice(0, 400), evidenceIds: useful.map((item) => item.id).slice(0, 100) });
    if (notUseful.length) preferences.push({ direction: 'avoid', pattern: `Optional fundraisers and sales, like “${notUseful[0]!.title}”`.slice(0, 400), evidenceIds: notUseful.map((item) => item.id).slice(0, 100) });
    return { overview: `Synthetic summary of ${input.length} rated suggestion${input.length === 1 ? '' : 's'} (${useful.length} useful, ${notUseful.length} not useful)${previous.length ? `, refining ${previous.length} earlier preference${previous.length === 1 ? '' : 's'}` : ''}.`.slice(0, 700), preferences };
  },
};
// The model behind the app's trial-summary, transcription and knowledge-upkeep paths.
const previewLlm: LlmProvider = {
  id: 'preview',
  capabilities: { images: false, pdf: false, tools: false, webSearch: false, reasoning: false, transcription: true },
  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const text = request.messages.flatMap((message) => message.role === 'user' ? message.content : []).map((part) => part.type === 'text' ? part.text : '').join('');
    let object: unknown;
    if (request.schemaName === 'personal_relevance_summary') {
      const payload = JSON.parse(text) as { examples: TrialSummaryInput; previous?: TrialSummary['preferences'] };
      object = await previewTrialSummary.summarize(payload.examples, payload.previous ?? []);
    } else if (request.schemaName === 'knowledge_maintenance') object = { proposals: [] };
    else throw llmError('AI_UNSUPPORTED');
    return { type: 'object', object: request.schema.parse(object), usage: { inputTokens: 0, outputTokens: 0 }, model: request.model };
  },
  async transcribe() { return 'Add oat milk and bananas to groceries'; },
};
const maintenanceProposals = (school: number): KnowledgeMaintenanceProvider => ({
  async generate() {
    return { result: { proposals: [
      { operation: 'add', targetKeys: ['gymnastics_day'], baseRevisions: [0], proposedValue: 'Gymnastics at the Riverside Rec Center on Mondays at 5 PM', provenanceRefs: ['preview-email-rec'], reason: 'Two recent emails from the rec center mention a weekly Monday gymnastics class.' },
      { operation: 'update', targetKeys: ['school_pickup_time'], baseRevisions: [school], proposedValue: 'Weekdays at 3:15 PM; early dismissal at 12:30 PM on the first Friday of each month', provenanceRefs: ['preview-email-pta'], reason: 'The PTA newsletter announced monthly early-dismissal Fridays.' },
    ] }, usage: { inputTokens: 0, outputTokens: 0 }, provider: 'preview', model: CHAT_MODEL };
  },
});

// ---------------------------------------------------------------------------
// App, worker and seed
// ---------------------------------------------------------------------------
const db = new Database(dbPath); migrate(db);
const key = keyFromSecret(config.SESSION_SECRET);
const grant: GoogleGrant = { sub: 'preview-google-sub-alex', email: MEMBERS.alex.allowedEmail, scopes: [...GOOGLE_SCOPES], accessToken: 'preview-access-token', refreshToken: 'preview-refresh-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
const google = new PreviewGoogleProvider(db, { [GOOGLE_CODE]: grant });
const members = () => db.prepare('SELECT id, household_id as householdId, access_subject as accessSubject, allowed_email as allowedEmail, display_name as displayName, timezone, active FROM members WHERE active = 1').all() as MemberRecord[];
const actorFor = (who: MemberKey): Actor => ({ memberId: MEMBERS[who].id, householdId: HOUSEHOLD_ID });
const recordFor = (who: MemberKey): MemberRecord => members().find((member) => member.id === MEMBERS[who].id)!;

const queue = new JobQueue(db);
const calendars = new CalendarRepository(db, key);
const planRepository = new PlanRepository(db, key);
const calendarActions = new CalendarActionService(db, key, queue, google);
const decisions = new PlanDecisionService(db, planRepository, calendarActions);
const assistant = new AssistantService(db, key, true, new PreviewAgent(), undefined, decisions);
const dailyOverviews = new DailyOverviewService(db, key, previewDailyOverview, CHAT_MODEL);
const sources = new SourceRepository(db, key);
const quietLog = (event: string, fields: { kind?: string; code?: string }) => { if (event === 'job_failed') console.warn(`[worker] ${fields.kind ?? 'job'} failed: ${fields.code ?? 'unknown'}`); };
const scheduler = new Scheduler(db, queue, sources);
const worker = new Worker(queue, new GmailSync(db, key, google, queue, sources), db, scheduler, undefined, quietLog, new CalendarSync(db, key, google, queue, calendars), undefined, calendarActions, new ReminderService(db, key, new FakePushProvider()), assistant, new MorningDigestService(db, key, new FakePushProvider(), false), new ActivityNotificationService(db, key, new FakePushProvider(), false), dailyOverviews, new KnowledgeMaintenanceService(db, key, undefined, CHAT_MODEL), new RelevanceTrialService(db, key, undefined, previewTrialSummary));
// Calendar writes resync the destination right away instead of on the next 5-minute bucket.
google.onWrite = () => {
  const destination = db.prepare(`SELECT cs.id, gc.id AS connectionId, gc.generation FROM destination_bindings d JOIN calendar_selections cs ON cs.calendar_key = d.calendar_key
    JOIN google_connections gc ON gc.id = cs.connection_id AND gc.generation = cs.generation WHERE d.active = 1 AND gc.status = 'active' LIMIT 1`).get() as { id: string; connectionId: string; generation: number } | undefined;
  if (destination) queue.enqueue({ kind: 'calendar_sync', scopeId: destination.connectionId, dedupeKey: `calendar-sync:${destination.id}:preview-write:${randomUUID()}`, payload: { connectionId: destination.connectionId, generation: destination.generation, calendarSelectionId: destination.id } });
};
async function drain() { scheduler.tick(); for (let index = 0; index < 500 && await worker.runOnce(); index++) { /* Process everything that is due now. */ } }

async function seed() {
  // A movable clock gives seeded records realistic "received/created N hours ago" timestamps.
  let seedTime = Date.now(); const seedClock = () => new Date(seedTime); const hoursAgo = (hours: number) => { seedTime = Date.now() - hours * 3600_000; };
  const now = new Date().toISOString();
  const alex = actorFor('alex'); const sam = actorFor('sam');
  db.prepare('INSERT INTO households (id, created_at) VALUES (?, ?)').run(HOUSEHOLD_ID, now);
  for (const member of Object.values(MEMBERS)) db.prepare('INSERT INTO members (id, household_id, access_subject, allowed_email, display_name, timezone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(member.id, HOUSEHOLD_ID, member.accessSubject, member.allowedEmail, member.displayName, ZONE, now);

  // Google: the real consent callback, calendar selection and destination path, backed by synthetic Google.
  const store = new SessionStore(db, Buffer.from(config.SESSION_SECRET).subarray(0, 32));
  const browser = store.create(recordFor('alex')).data;
  const connections = new ConnectionService(db, key, google, ORIGIN);
  const consent = await connections.start(recordFor('alex'), browser, 'v1');
  await connections.callback(recordFor('alex'), browser, new URL(consent.authorizationUrl).searchParams.get('state')!, GOOGLE_CODE);
  store.revoke(browser.id);
  const calendarRows = connections.calendars(alex.memberId);
  await connections.setCalendars(recordFor('alex'), calendarRows.map((calendar) => ({ id: calendar.id, selected: true, classification: calendar.name === 'Family' ? 'household' as const : 'personal' as const })));
  connections.setDestination(recordFor('alex'), calendarRows.find((calendar) => calendar.name === 'Family')!.id, connections.status(alex.memberId).revision);
  connections.setSourcePolicy(alex.memberId, { excludedSenders: ['deals@coupons.example.com'], excludedLabels: ['CATEGORY_PROMOTIONS'], genericAppointmentOptIn: false, expectedRevision: 1 });
  const connection = db.prepare('SELECT id, generation FROM google_connections WHERE member_id = ?').get(alex.memberId) as { id: string; generation: number };

  // Settings and consents through their services.
  for (const actor of [alex, sam]) {
    assistant.consent(actor, true);
    dailyOverviews.setSettings(actor, { enabled: true, expectedRevision: 0, consentVersion: DAILY_AI_CONSENT });
  }
  const digest = new MorningDigestService(db, key, new FakePushProvider(), true);
  digest.set(alex, { enabled: true, localTime: '07:00', expectedRevision: 0 });
  digest.set(sam, { enabled: true, localTime: '06:45', expectedRevision: 0 });
  new BackgroundAiService(db, true).set(alex, true, 0);
  const reminders = new ReminderService(db, key, new FakePushProvider(), seedClock);
  reminders.subscribe(alex, { endpoint: 'https://web.push.apple.com/preview-synthetic-alex-iphone', p256dh: 'preview-synthetic-p256dh-alex', auth: 'preview-auth-alex', label: 'iPhone (synthetic preview)' });
  reminders.subscribe(sam, { endpoint: 'https://web.push.apple.com/preview-synthetic-sam-iphone', p256dh: 'preview-synthetic-p256dh-sam', auth: 'preview-auth-sam', label: 'Sam’s iPhone (synthetic preview)' });
  await drain(); // First Gmail + calendar sync through the real sync code.

  // Email-derived suggestions: real source versions, then the extraction upsert path.
  const seedSources = new SourceRepository(db, key, seedClock);
  const plans = new PlanRepository(db, key, seedClock);
  const email = (hours: number, subject: string, sender: string, text: string) => {
    hoursAgo(hours); const providerId = `preview-msg-${randomBytes(6).toString('hex')}`;
    return seedSources.persistMessage({ memberId: alex.memberId, householdId: HOUSEHOLD_ID, connectionId: connection.id, generation: connection.generation, queue, message: { providerId, threadId: providerId, subject, sender, labels: ['INBOX', 'CATEGORY_PERSONAL'], text, internalDate: seedClock().toISOString(), messageId: `<${providerId}@mail.example.org>`, attachmentsIncomplete: false } }).versionId!;
  };
  const suggest = (sourceVersionId: string, facts: PlanFacts, relation: 'new' | 'update' = 'new', visibility: 'shared' | 'private' = 'shared') => plans.upsertExtraction({ id: randomUUID(), sourceVersionId, ownerId: alex.memberId, householdId: HOUSEHOLD_ID, visibility, facts, relation, evidenceRole: 'supporting' });
  const base = { participants: [] as string[], preparationTasks: [] as string[], unresolvedFields: [] as string[] };

  const pictureDay = suggest(email(30, 'Picture day is this week!', 'Brookside PTA <pta@brookside.example.org>', `Hi families,\n\nPicture day is ${at(2, '00:00').toFormat('cccc, LLLL d')}. Students should wear a collared shirt. Order forms went home in backpacks — please return them by picture day. Retakes will be next month.\n\nThanks!\nBrookside PTA (synthetic example)`),
    { ...base, title: 'Picture day at Brookside Elementary', category: 'school', participants: ['Alex', 'Sam'], time: allDay(2), location: 'Brookside Elementary', notes: 'Retakes next month. Order forms went home in backpacks.', preparationTasks: ['Pick out a collared shirt', 'Return the photo order form'] });
  const soccerFacts: PlanFacts = { ...base, title: 'Lions U8 soccer practice', category: 'activities', participants: ['Alex'], time: timed(1, '17:30', '18:30'), location: 'Riverside Park, Field 3', notes: 'Bring shin guards and a full water bottle.' };
  const soccer = suggest(email(120, 'Practice schedule for this week', 'Lions U8 Coach <coach@lions-soccer.example.org>', `Hi Lions parents — practice is ${at(1, '17:30').toFormat('cccc')} 5:30–6:30 PM at Riverside Park, Field 3. Shin guards required. (synthetic example)`), soccerFacts);
  hoursAgo(96); plans.edit(soccer, sam.memberId, plans.detail(soccer, sam.memberId).revision, { ...soccerFacts, notes: 'Bring shin guards and a full water bottle. Sam has the spare cleats in the car.' });
  hoursAgo(95); new PlanDecisionService(db, plans, new CalendarActionService(db, key, queue, google, seedClock), seedClock).decide(alex, soccer, plans.detail(soccer, alex.memberId).revision, 'calendar');
  const dinnerFacts: PlanFacts = { ...base, title: 'Dinner with the Okafors', category: 'social', participants: ['Alex', 'Sam'], time: timed(0, '19:00', '21:00'), location: 'Harbor Grill, 12 Example St', notes: 'Reservation under Alex for 4.' };
  const dinner = suggest(email(52, 'Re: Dinner this weekend?', 'Ada Okafor <ada@okafor.example.net>', `We'd love to! ${at(0, '19:00').toFormat('cccc')} at 7 works. I booked Harbor Grill for 4 people. (synthetic example)`), dinnerFacts);
  hoursAgo(50); new PlanDecisionService(db, plans, new CalendarActionService(db, key, queue, google, seedClock), seedClock).decide(alex, dinner, plans.detail(dinner, alex.memberId).revision, 'calendar');
  await drain(); // Calendar actions reach Google (synthetic) and the destination resyncs.
  suggest(email(6, 'UPDATE: practice moved to Field 5, starts 6:00', 'Lions U8 Coach <coach@lions-soccer.example.org>', 'Quick change — tomorrow\'s practice starts at 6:00 PM on Field 5 because of field maintenance. (synthetic example)'),
    { ...soccerFacts, time: timed(1, '18:00', '19:00'), location: 'Riverside Park, Field 5', notes: 'Moved to Field 5 because of field maintenance.' }, 'update');
  const permissionSlip = suggest(email(18, 'Field trip permission slip', 'Ms. Rivera <rivera@brookside.example.org>', 'Reminder: permission slips and $12 for the science museum trip are due tomorrow morning at drop-off. (synthetic example)'),
    { ...base, title: 'Field trip permission slip due', category: 'school', participants: ['Alex'], time: deadline(1, '08:00'), notes: 'Science museum trip.', preparationTasks: ['Sign the permission slip', 'Send $12 in an envelope'] });
  suggest(email(20, 'Parent-teacher conference sign-ups', 'Brookside Office <office@brookside.example.org>', `Conferences are on ${at(6, '00:00').toFormat('cccc, LLLL d')}. Your teacher will confirm a time slot soon. (synthetic example)`),
    { ...base, title: 'Parent-teacher conference', category: 'school', participants: ['Alex', 'Sam'], time: { kind: 'unresolved', dateHint: localDate(6), missing: ['start', 'end'] }, unresolvedFields: ['start', 'end'] });
  const bookFair = suggest(email(40, 'Book fair volunteers needed', 'Brookside PTA <pta@brookside.example.org>', 'Can you help at the book fair? Shifts run 2–4 PM. (synthetic example)'),
    { ...base, title: 'Book fair volunteer shift', category: 'school', participants: ['Sam'], time: timed(3, '14:00', '16:00'), location: 'Brookside Elementary library' });
  suggest(email(10, 'Thanks for volunteering!', 'Ms. Rivera <rivera@brookside.example.org>', 'Thanks for signing up for the book fair — your shift is 2:30–4 PM. (synthetic example)'),
    { ...base, title: 'Book fair volunteer shift', category: 'school', participants: ['Sam'], time: timed(3, '14:30', '16:00'), location: 'Brookside Elementary library', notes: 'Teacher confirmation.' });
  const blockParty = suggest(email(70, 'Elm Street block party 🎉', 'Elm Street Neighbors <hello@elmstreet.example.org>', 'Save the date for the annual block party! Bring a dish to share. (synthetic example)'),
    { ...base, title: 'Neighborhood block party', category: 'social', participants: ['Alex', 'Sam'], time: allDay(17), location: 'Elm Street', preparationTasks: ['Bring a dish to share'] });
  suggest(email(26, 'Your vehicle registration renewal', 'Motor Vehicles (synthetic) <no-reply@motor-vehicles.example.org>', 'Your registration expires soon. Renew online before the due date to avoid a late fee. (synthetic example)'),
    { ...base, title: 'Renew car registration', category: 'admin', participants: ['Alex'], time: deadline(21, '17:00'), notes: 'Renew online to avoid the late fee.' }, 'new', 'private');
  const grandparents = suggest(email(60, 'Our visit!', 'Grandma (synthetic) <grandma@family.example.net>', 'We land on the morning of the 9th and can stay through the weekend. (synthetic example)'),
    { ...base, title: 'Grandparents’ visit', category: 'family', participants: ['Alex', 'Sam'], time: allDay(9, 3), notes: 'Arriving in the morning.' });
  hoursAgo(58); decisions.decide(alex, grandparents, plans.detail(grandparents, alex.memberId).revision, 'keep');
  const fundraiser = suggest(email(90, 'Wrapping paper fundraiser', 'Brookside PTA <pta@brookside.example.org>', 'Our annual wrapping paper sale is back! Order forms due next week. (synthetic example)'),
    { ...base, title: 'Wrapping paper fundraiser orders due', category: 'school', participants: [], time: deadline(7, '08:00') });
  hoursAgo(80); plans.dismiss(fundraiser, sam.memberId, plans.detail(fundraiser, sam.memberId).revision);
  hoursAgo(14); plans.createPrivate(alex, { ...base, title: 'Dentist cleaning', category: 'health', participants: ['Alex'], time: timed(5, '10:00', '11:00'), location: 'Smile Dental (synthetic), 45 Example Ave', notes: 'Bring the new insurance card.' });
  // Email extraction was simulated above; record it as processed instead of leaving queue jobs behind.
  db.prepare("UPDATE jobs SET state = 'succeeded', updated_at = ? WHERE kind = 'extract_source' AND state IN ('ready','retry_wait')").run(now);
  for (const row of db.prepare("SELECT sv.id, sv.observed_at FROM source_versions sv JOIN source_items si ON si.id = sv.source_id WHERE si.kind = 'gmail_message'").all() as Array<{ id: string; observed_at: string }>) db.prepare("INSERT INTO extractions (id, source_version_id, provider, model, prompt_version, policy_version, input_digest, state, encrypted_result, usage_json, expires_at, created_at, updated_at) VALUES (?, ?, 'preview', 'preview-synthetic-extract', 'preview', 'preview', ?, 'succeeded', NULL, '{}', ?, ?, ?)").run(randomUUID(), row.id, randomUUID(), new Date(Date.now() + 30 * 86400_000).toISOString(), row.observed_at, row.observed_at);

  // Lists.
  const lists = new ListService(db, key, seedClock);
  const add = (who: Actor, kind: 'grocery' | 'todo', title: string, extra: { quantity?: string; assigneeId?: string; due?: string; done?: boolean; hours?: number } = {}) => {
    hoursAgo(extra.hours ?? 30); const item = lists.create(who, kind, title, extra.quantity, extra.assigneeId, extra.due, `preview-seed:${kind}:${title}`) as { id: string; revision: number };
    if (extra.done) { hoursAgo((extra.hours ?? 30) - 4); lists.update(who, item.id, item.revision, { completed: true }); }
    return item;
  };
  add(alex, 'grocery', 'Oat milk', { quantity: '2 cartons', hours: 50 });
  add(sam, 'grocery', 'Bananas', { quantity: '1 bunch', hours: 44 });
  add(alex, 'grocery', 'Eggs', { quantity: '1 dozen', hours: 30 });
  add(sam, 'grocery', 'Baby spinach', { hours: 22 });
  add(alex, 'grocery', 'Sourdough bread', { hours: 8 });
  add(sam, 'grocery', 'Coffee beans', { quantity: '1 bag', hours: 60, done: true });
  add(alex, 'grocery', 'Dish soap', { hours: 54, done: true });
  add(alex, 'todo', 'Call the plumber about the kitchen sink', { due: localDate(0), hours: 28 });
  const waterBill = add(alex, 'todo', 'Pay the water bill', { due: localDate(-1), hours: 72 });
  add(alex, 'todo', 'Schedule an oil change', { due: localDate(4), hours: 36 });
  const gift = add(alex, 'todo', 'Order a birthday gift for the Parkers’ party', { due: localDate(2), assigneeId: sam.memberId, hours: 20 });
  const garage = add(sam, 'todo', 'Clean out the garage', { due: localDate(0), hours: 100 });
  hoursAgo(12); lists.snooze(sam, garage.id, garage.revision, localDate(7));
  add(sam, 'todo', 'Return library books', { hours: 80, done: true });
  add(alex, 'todo', 'Book flu shots', { hours: 90, done: true });

  // Reminders (absolute times so the worker never reschedules them).
  hoursAgo(5);
  const later = DateTime.now().setZone(ZONE).plus({ minutes: 90 }).startOf('minute');
  reminders.create(alex, { parentType: 'plan', parentId: dinner, recipientId: alex.memberId, dueAt: iso(later), timezone: ZONE }, 'preview-seed-reminder-dinner');
  reminders.create(alex, { parentType: 'plan', parentId: permissionSlip, recipientId: alex.memberId, dueAt: iso(at(1, '07:30')), timezone: ZONE }, 'preview-seed-reminder-slip');
  reminders.create(alex, { parentType: 'list_item', parentId: waterBill.id, recipientId: alex.memberId, dueAt: iso(at(1, '18:00')), timezone: ZONE }, 'preview-seed-reminder-water');
  reminders.create(sam, { parentType: 'list_item', parentId: gift.id, recipientId: sam.memberId, dueAt: iso(at(1, '12:00')), timezone: ZONE }, 'preview-seed-reminder-gift');

  // Household knowledge, history and maintenance proposals.
  const knowledge = new KnowledgeRepository(db, key, seedClock);
  hoursAgo(200); knowledge.set(alex, { key: 'school_pickup_time', value: 'Weekdays at 3:15 PM at the Brookside Elementary side entrance', expectedRevision: 0 });
  hoursAgo(190); knowledge.set(alex, { key: 'dietary_preference', value: 'Vegetarian dinners on weeknights', expectedRevision: 0 });
  hoursAgo(40); knowledge.set(alex, { key: 'dietary_preference', value: 'Vegetarian dinners on weeknights; Sam avoids shellfish', expectedRevision: 1 });
  hoursAgo(150); knowledge.set(alex, { key: 'preferred_grocery_store', value: 'Greenleaf Market on Example Ave', expectedRevision: 0 });
  hoursAgo(120); knowledge.set(alex, { key: 'soccer_team', value: 'Lions U8 — practices at Riverside Park', expectedRevision: 0, provenance: 'source', confirmation: 'unconfirmed', reason: 'assistant-review', origin: 'review' });
  hoursAgo(60); knowledge.set(alex, { key: 'grandparents_visit', value: 'Grandparents staying with us', expectedRevision: 0, validFrom: localDate(9), validUntil: localDate(12) });
  hoursAgo(100); knowledge.set(sam, { key: 'coffee_order', value: 'Oat milk flat white', expectedRevision: 0 });
  await new KnowledgeMaintenanceService(db, key, maintenanceProposals(knowledge.get(alex, 'school_pickup_time')!.revision), CHAT_MODEL).maintain(alex, 'preview-seed-maintenance', [{ ref: 'preview-email-rec', summary: 'Weekly Monday gymnastics class at the rec center (synthetic).' }, { ref: 'preview-email-pta', summary: 'Monthly early-dismissal Fridays (synthetic).' }]);

  // Assistant request history through submit + the worker's assistant job.
  const seededAssistant = new AssistantService(db, key, true, undefined, seedClock);
  const submit = (who: Actor, hours: number, text: string) => { hoursAgo(hours); return seededAssistant.submit(who, `preview-seed-${randomUUID()}`, text).id; };
  const groceriesRun = submit(alex, 26, 'Add Greek yogurt, blueberries and 2 lbs of apples to groceries and remind me to call the eye doctor about new glasses');
  const dinnerRun = submit(alex, 20, 'Dinner with the Parkers Friday 7pm at Harbor Grill');
  const rememberRun = submit(alex, 9, 'Remember that art class is on Thursdays at 4 PM');
  submit(alex, 3, "What's on the calendar today?");
  submit(alex, 1, 'Read the snack schedule at https://docs.google.com/spreadsheets/d/preview-synthetic-sheet');
  submit(sam, 2, 'Add paper towels to the shopping list');
  await drain();
  assistant.feedback(alex, groceriesRun, 'helpful');
  assistant.review(alex, dinnerRun, 'item', 0, 'keep');
  assistant.review(alex, rememberRun, 'knowledge', 0, 'save');

  // Relevance trial with a few ratings, a cached summary and learned preferences.
  const trial = new RelevanceTrialService(db, key, undefined, previewTrialSummary);
  trial.prepare(alex, [pictureDay, fundraiser, blockParty, permissionSlip, bookFair]);
  const itemFor = (planTitle: string) => trial.list(alex).items.find((item) => item.facts.title === planTitle)!;
  trial.rate(alex, itemFor('Picture day at Brookside Elementary').id, { value: 'useful', reason: 'Picture day needs prep the night before.', expectedRevision: 1 });
  trial.rate(alex, itemFor('Wrapping paper fundraiser orders due').id, { value: 'not_useful', reason: 'We never take part in the wrapping paper sale.', expectedRevision: 1 });
  trial.rate(alex, itemFor('Neighborhood block party').id, { value: 'skip', reason: '', expectedRevision: 1 });
  await trial.compact(alex);
  trial.configureLearning(alex, { enabled: true, expectedRevision: 0, consentVersion: 'personal-relevance-v1' });
  await trial.learn(alex, { localDate: localDate(0), timezone: ZONE, consentRevision: dailyOverviews.settings(alex).revision });

  // Morning review last, so it reflects everything above.
  await drain();
  for (const who of ['alex', 'sam'] as const) {
    const view = await dailyOverviews.generate(actorFor(who), `preview-seed:${who}:${randomUUID()}`);
    if (view.state !== 'ready') console.warn(`native-preview: ${MEMBERS[who].displayName}'s morning review is ${view.state} (${view.errorCode ?? 'no code'})`);
  }
}

if (!reuse) await seed(); else { await drain(); }
const verifyAccess = async () => ({ subject: MEMBERS[signedIn as MemberKey].accessSubject });
const app = createApp({ db, config, verifyAccess, members, google, dailyOverviewProvider: previewDailyOverview, llm: staticHub(previewLlm, { main: CHAT_MODEL, email: 'preview-synthetic-extract', transcribe: 'preview-synthetic-transcribe' }), ...(process.env.WEB_DIST ? { webDist: process.env.WEB_DIST } : {}) });
const timer = worker.start(1_000);
// Preview-only: lift the paid-AI throttles (5-minute coalescing, 12 per day) so the
// synthetic morning review regenerates within seconds after the app changes something.
const reviewTimer = setInterval(() => {
  const now = new Date().toISOString();
  db.prepare("DELETE FROM ai_usage_attempts WHERE feature = 'daily_overview' AND outcome NOT IN ('reserved', 'running')").run();
  db.prepare("UPDATE jobs SET run_after = ? WHERE kind = 'daily_overview' AND state IN ('ready', 'retry_wait') AND run_after > ?").run(now, now);
}, 2_000);
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });

const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM plans WHERE status NOT IN ('dismissed','archived')) AS plans, (SELECT COUNT(*) FROM calendar_occurrences) AS events,
  (SELECT COUNT(*) FROM list_items WHERE archived_at IS NULL) AS listItems, (SELECT COUNT(*) FROM assistant_runs) AS runs`).get() as Record<string, number>;
console.log([
  '',
  '  ⚠  SYNTHETIC PREVIEW — fake household data for local iOS development only.',
  '     Outbound network is blocked; Google, AI and push providers are fakes.',
  '',
  `  URL        ${ORIGIN}`,
  `  Sign-in    ${ORIGIN}/dashboard/native/authorize (Access is simulated)`,
  `  Signed in  ${MEMBERS[signedIn as MemberKey].displayName} (set PREVIEW_MEMBER=${signedIn === 'alex' ? 'sam' : 'alex'} to switch)`,
  `  Members    ${Object.values(MEMBERS).map((member) => `${member.displayName} <${member.allowedEmail}>`).join(', ')}`,
  `  Database   ${dbPath}${reuse ? ' (reused, not reseeded)' : tempDir ? ' (temporary, deleted on exit)' : ' (seeded)'}`,
  `  Contents   ${counts.plans} active plans, ${counts.events} calendar events, ${counts.listItems} list items, ${counts.runs} assistant requests`,
  '',
  '  Use 127.0.0.1 (not localhost): sign-in confirmation checks the exact origin.',
  '',
].join('\n'));

const shutdown = () => {
  clearInterval(timer);
  clearInterval(reviewTimer);
  server.close();
  db.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
