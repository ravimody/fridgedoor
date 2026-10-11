import { isInboxMessage } from '../sync/gmail-scope.js';
import { PersonalRelevanceRepository } from '../repos/personal-relevance.js';
import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { normalizedTimeSchema, type NormalizedTime, type PlanSummary } from '@fridgedoor/contracts';
import { decryptJson, indexKey, type Envelope } from '../crypto.js';
import { CalendarRepository, type CalendarDateWindow } from '../repos/calendar.js';
import { KnowledgeRepository } from '../repos/knowledge.js';
import { PlanRepository } from '../repos/plans.js';
import type { SourceEvidence } from '../repos/sources.js';

export type DailyContextActor = { memberId: string; householdId: string };
export type DailyCandidateKind = 'calendar' | 'plan' | 'task' | 'reminder' | 'source';
export type DailyCoverageStatus = 'fresh' | 'stale' | 'disabled' | 'unavailable' | 'truncated';
export type DailyCoverage = {
  channel: 'calendar' | 'email' | 'plans' | 'tasks' | 'reminders' | 'knowledge';
  status: DailyCoverageStatus;
  lastSuccessAt: string | null;
  omittedCount: number;
};
export type DailyCandidate = {
  ref: string;
  kind: DailyCandidateKind;
  title: string;
  detail?: string;
  normalizedTime: NormalizedTime | null;
  state: string;
  revision: number | null;
  generation: number | null;
  sourceRefs: string[];
  navigation: { kind: DailyCandidateKind; id: string };
  required: boolean;
};
export type DailyTruncation = {
  candidateLimit: number;
  inputTokenLimit: number;
  estimatedInputTokens: number;
  omittedCount: number;
  omittedByKind: Record<DailyCandidateKind, number>;
  omittedKnowledgeCount: number;
};
export type DailyContext = {
  referenceTime: string;
  referenceDate: string;
  timezone: string;
  coverage: DailyCoverage[];
  personalPreferences?: Array<{direction:'prefer'|'avoid'|'uncertain';pattern:string}>;
  knowledge: Array<{ key: string; value: string; validity: 'current' | 'future'; revision: number; provenance: 'legacy'|'user'|'source'|'maintenance'; confirmation: 'confirmed'|'unconfirmed'; validFrom: string | null; validUntil: string | null }>;
  candidates: DailyCandidate[];
  truncation: DailyTruncation;
};

export type DailyFallbackItem = {
  ref: string;
  title: string;
  detail: string;
  kind: DailyCandidateKind;
  normalizedTime: NormalizedTime | null;
  sourceRefs: string[];
  required: boolean;
};
export type DailyFallback = { summary: string; items: DailyFallbackItem[]; coverageNotice: string[] };

const CANDIDATE_LIMIT = 150;
const INPUT_TOKEN_LIMIT = 12_000;
const PROMPT_TOKEN_RESERVE = 1_000;
const SOURCE_LOOKBACK_DAYS = 7;
const OVERDUE_LOOKBACK_DAYS = 7;
const LOOKAHEAD_DAYS = 8;

type RankedCandidate = DailyCandidate & { rank: number; sortAt: number };
type Clock = () => Date;

export class DailyContextService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: Clock = () => new Date()) {}

  build(actor: DailyContextActor): DailyContext {
    const now = this.clock();
    const member = this.db.prepare('SELECT timezone FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId) as { timezone: string } | undefined;
    if (!member || !DateTime.fromJSDate(now).setZone(member.timezone).isValid) throw new Error('NOT_FOUND');
    const local = DateTime.fromJSDate(now).setZone(member.timezone);
    const today = local.startOf('day');
    const lookahead = today.plus({ days: LOOKAHEAD_DAYS });
    const overdue = today.minus({ days: OVERDUE_LOOKBACK_DAYS });
    const window: CalendarDateWindow = {
      startUtc: today.toUTC().toISO()!,
      endUtc: lookahead.toUTC().toISO()!,
      startDate: today.toISODate()!,
      endDateExclusive: lookahead.toISODate()!,
    };
    const actionWindow: CalendarDateWindow = {
      startUtc: overdue.toUTC().toISO()!,
      endUtc: lookahead.toUTC().toISO()!,
      startDate: overdue.toISODate()!,
      endDateExclusive: lookahead.toISODate()!,
    };
    const sourceStart = now.getTime() - SOURCE_LOOKBACK_DAYS * 86400000;
    const sourceRefs = new Map<string, string>();
    const refForSource = (lineage: string) => {
      const existing = sourceRefs.get(lineage);
      if (existing) return existing;
      const ref = `source-${indexKey(lineage, this.key).slice(0, 32)}`;
      sourceRefs.set(lineage, ref);
      return ref;
    };
    const ranked: RankedCandidate[] = [];
    const add = (candidate: Omit<DailyCandidate, 'ref'>, rank: number, sortAt: number) => ranked.push({ ...candidate, ref: `candidate-${indexKey(JSON.stringify({ kind: candidate.kind, title: candidate.title, detail: candidate.detail, normalizedTime: candidate.normalizedTime, state: candidate.state, navigation: candidate.navigation }), this.key).slice(0, 32)}`, rank, sortAt });

    const calendar = new CalendarRepository(this.db, this.key, this.clock);
    for (const item of calendar.contextItems(actor, window)) {
      const rank = timeRank(item.time, today, lookahead);
      add({
        kind: 'calendar', title: item.title, normalizedTime: item.time, state: item.status, revision: null,
        generation: item.generation, sourceRefs: [refForSource(`source:${item.sourceId}`)],
        navigation: { kind: 'calendar', id: item.id }, required: rank === 0,
      }, rank, timeSortAt(item.time, now, member.timezone));
    }

    const plans = new PlanRepository(this.db, this.key, this.clock).list(actor.memberId);
    const plansById = new Map(plans.map((plan) => [plan.id, plan]));
    const recentSuggestionStart = today.minus({ days: 2 }).toMillis();
    const suggestionWindow = { ...window, endUtc: today.plus({ days: 3 }).toUTC().toISO()!, endDateExclusive: today.plus({ days: 3 }).toISODate()! };
    for (const plan of plans) {
      const facts = plan.pendingFacts ?? plan.facts;
      const version=this.db.prepare('SELECT origin FROM plan_versions WHERE id=(SELECT COALESCE(pending_version_id,current_version_id) FROM plans WHERE id=?)').get(plan.id) as {origin:string}|undefined;
      const committed=plan.savedInPlanner || Boolean(plan.calendarAction) || version?.origin==='user';
      const planTime = facts.time;
      const inWindow = !planTime || timeOverlaps(planTime, actionWindow);
      if (!inWindow) continue;
      if (!committed) {
        const recent = Date.parse(plan.createdAt) >= recentSuggestionStart;
        const upcoming = planTime && timeOverlaps(planTime, window);
        const nearTerm = planTime && timeOverlaps(planTime, suggestionWindow);
        const consequentialDeadline = planTime?.kind === 'deadline' && upcoming;
        const recentAmbiguity = recent && (!planTime || planTime.kind === 'deadline' || planTime.kind === 'unresolved');
        // An unsaved email suggestion is not a durable commitment. Keep near-term
        // suggestions, consequential deadlines and recent ambiguity, not the backlog.
        if (!nearTerm && !consequentialDeadline && !recentAmbiguity) continue;
      }
      const sourceRefsForPlan = this.planSourceRefs(plan.id, actor.memberId, refForSource);
      const hasPreparation = facts.preparationTasks.length > 0;
      if (!['dismissed','archived'].includes(plan.status)) {
        const rank = planTime ? timeRank(planTime, today, lookahead, overdue) : 2;
        add({
          kind: 'plan', title: facts.title, detail: [facts.notes, ...(!committed ? facts.preparationTasks.slice(0, 3) : [])].filter(Boolean).join(' · ').slice(0, 240), normalizedTime: planTime ?? null, state: plan.status,
          revision: plan.revision, generation: null, sourceRefs: sourceRefsForPlan,
          navigation: { kind: 'plan', id: plan.id }, required: committed && planTime?.kind === 'deadline' && rank === 0,
        }, rank, timeSortAt(planTime ?? null, now, member.timezone));
      }
      if (committed && hasPreparation && !['dismissed','archived'].includes(plan.status)) {
        for (const preparationTask of facts.preparationTasks) {
          add({
            kind: 'task', title: preparationTask, normalizedTime: planTime ?? null, state: plan.status,
            revision: plan.revision, generation: null, sourceRefs: sourceRefsForPlan,
            navigation: { kind: 'plan', id: plan.id }, required: false,
          }, planTime ? Math.max(1, timeRank(planTime, today, lookahead, overdue)) : 2, timeSortAt(planTime ?? null, now, member.timezone));
        }
      }
    }

    const listRows = this.db.prepare(`SELECT id, title, due_time_json, snoozed_until, revision, created_at
      FROM list_items WHERE household_id = ? AND kind = 'todo' AND completed_at IS NULL AND archived_at IS NULL`).all(actor.householdId) as Array<{ id: string; title: string; due_time_json: string | null; snoozed_until: string | null; revision: number; created_at: string }>;
    for (const row of listRows) {
      const time = row.due_time_json ? listTime(row.due_time_json, member.timezone) : null;
      if (row.snoozed_until && row.snoozed_until > local.toISODate()!) continue;
      const future = time && timeSortAt(time,now,member.timezone) >= today.plus({days:1}).toMillis();
      if(future && !timeOverlaps(time!,actionWindow)) continue;
      const rank = future ? 1 : 0;
      add({ kind: 'task', title: row.title, normalizedTime: time, state: 'open', revision: row.revision, generation: null, sourceRefs: [], navigation: { kind: 'task', id: row.id }, required: rank === 0, detail: 'Open to-do. Its date is a reminder date, not an overdue deadline. Keep it visible until completed, snoozed or deleted.' }, rank, timeSortAt(time, now, member.timezone) || Date.parse(row.created_at));
    }

    const reminderRows = this.db.prepare(`SELECT id, parent_type, parent_id, due_at, revision
      FROM reminders WHERE recipient_id = ? AND household_id = ? AND state = 'active'`).all(actor.memberId, actor.householdId) as Array<{ id: string; parent_type: string; parent_id: string; due_at: string; revision: number }>;
    for (const row of reminderRows) {
      // To-dos are represented by their durable task, including snooze visibility.
      if(row.parent_type==='list_item' && this.db.prepare("SELECT 1 FROM list_items WHERE id=? AND household_id=? AND kind='todo'").get(row.parent_id,actor.householdId)) continue;
      const time = deadlineTime(row.due_at, member.timezone);
      if (!timeOverlaps(time, actionWindow)) continue;
      const parent = reminderParent(row, plansById, this.db, actor.householdId, (planId) => this.planSourceRefs(planId, actor.memberId, refForSource));
      if (!parent) continue;
      const rank = timeRank(time, today, lookahead, overdue);
      add({ kind: 'reminder', title: parent.title, normalizedTime: time, state: 'active', revision: row.revision, generation: null, sourceRefs: parent.sourceRefs, navigation: { kind: 'reminder', id: row.id }, required: rank === 0 }, rank, timeSortAt(time, now, member.timezone));
    }

    const sourceRows = this.db.prepare(`SELECT si.id as source_id, si.generation, sv.id as version_id, sv.encrypted_evidence,
        sv.original_at, sv.observed_at
      FROM source_items si JOIN source_versions sv ON sv.id = si.current_version_id
      JOIN google_connections gc ON gc.id = si.connection_id
      WHERE si.owner_id = ? AND si.household_id = ? AND si.kind = 'gmail_message'
        AND si.state = 'available' AND gc.status = 'active' AND sv.availability = 'available'
        AND si.generation = gc.generation
        AND sv.expires_at > ? AND COALESCE(sv.original_at, sv.observed_at) >= ?
      ORDER BY COALESCE(sv.original_at, sv.observed_at) DESC`).all(actor.memberId, actor.householdId, now.toISOString(), new Date(sourceStart).toISOString()) as Array<{ source_id: string; generation: number; version_id: string; encrypted_evidence: string; original_at: string | null; observed_at: string }>;
    // Email suggestions own body review. Raw subjects must not bypass a skip
    // or produce unreviewed items while extraction is still queued/failed.
    const emailSuggestions = this.db.prepare("SELECT 1 FROM background_ai_settings WHERE member_id=? AND enabled=1 AND consent_version='background-ai-v1'").get(actor.memberId);
    for (const row of emailSuggestions ? [] : sourceRows) {
      if (!row.encrypted_evidence) continue;
      const evidence = decryptJson<SourceEvidence>(JSON.parse(row.encrypted_evidence) as Envelope, this.key, `source-version:${row.version_id}`);
      if (!isInboxMessage(evidence)) continue;
      const title = evidence.subject?.trim() || evidence.sender?.trim() || 'Recent household source';
      add({ kind: 'source', title: title.slice(0, 200), normalizedTime: null, state: 'available', revision: null, generation: row.generation, sourceRefs: [refForSource(`source:${row.source_id}`)], navigation: { kind: 'source', id: row.source_id }, required: false }, 2, Date.parse(row.original_at ?? row.observed_at));
    }

    const personalPreferences = new PersonalRelevanceRepository(this.db,this.key,this.clock).context(actor);
    const knowledge = new KnowledgeRepository(this.db, this.key, this.clock).context(actor, window.startDate, window.endDateExclusive);
    const omittedKnowledgeCount = trimKnowledge(knowledge,personalPreferences);
    // Allocate the bounded input to commitments before optional email discoveries.
    ranked.sort((a, b) => Number(b.required) - Number(a.required)
      || Number(b.kind === 'calendar') - Number(a.kind === 'calendar')
      || a.rank - b.rank || a.sortAt - b.sortAt || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
    const omittedByKind: Record<DailyCandidateKind, number> = { calendar: 0, plan: 0, task: 0, reminder: 0, source: 0 };
    const dismissed = new Set((this.db.prepare('SELECT candidate_ref FROM morning_dismissals WHERE owner_id=?').all(actor.memberId) as {candidate_ref:string}[]).map(row=>row.candidate_ref));
    const candidates: DailyCandidate[] = [];
    for (const candidate of ranked) {
      if(candidate.navigation.kind !== 'task' && dismissed.has(candidate.ref)) continue;
      if (candidates.length >= CANDIDATE_LIMIT || estimateTokens({ personalPreferences, knowledge, candidates: [...candidates, candidate] }) > INPUT_TOKEN_LIMIT) {
        omittedByKind[candidate.kind] += 1;
        continue;
      }
      candidates.push(stripRank(candidate));
    }
    const omittedCount = Object.values(omittedByKind).reduce((sum, count) => sum + count, 0);
    const estimatedInputTokens = estimateTokens({ personalPreferences, knowledge, candidates });
    return {
      referenceTime: now.toISOString(), referenceDate: local.toISODate()!, timezone: member.timezone,
      coverage: this.coverage(actor, now, omittedByKind, omittedKnowledgeCount), knowledge, personalPreferences,
      candidates,
      truncation: { candidateLimit: CANDIDATE_LIMIT, inputTokenLimit: INPUT_TOKEN_LIMIT, estimatedInputTokens, omittedCount, omittedByKind, omittedKnowledgeCount },
    };
  }

  fallback(context: DailyContext): DailyFallback {
    const required = context.candidates.filter((candidate) => candidate.required);
    const discretionary = context.candidates.filter((candidate) => !candidate.required && ['calendar', 'plan', 'task', 'reminder'].includes(candidate.kind));
    const selected = [...required, ...discretionary].slice(0, Math.max(8, required.length));
    const coverageNotice = context.coverage.filter((entry) => ['stale', 'unavailable', 'truncated'].includes(entry.status)).map((entry) => `${entry.channel} coverage is ${entry.status}`);
    const items = selected.map((candidate) => ({
      ref: candidate.ref, title: candidate.title, detail: fallbackDetail(candidate, context.referenceDate, context.timezone), kind: candidate.kind,
      normalizedTime: candidate.normalizedTime, sourceRefs: candidate.sourceRefs, required: candidate.required,
    }));
    const summary = items.length ? `${items.length} household item${items.length === 1 ? '' : 's'} need attention today or soon.` : 'No actionable household items were found in the available data.';
    return { summary, items, coverageNotice };
  }

  private planSourceRefs(planId: string, memberId: string, refForSource: (lineage: string) => string) {
    const rows = this.db.prepare(`SELECT si.id as source_id FROM plan_sources ps
      JOIN source_versions sv ON sv.id = ps.source_version_id JOIN source_items si ON si.id = sv.source_id
      LEFT JOIN google_connections gc ON gc.id = si.connection_id
      WHERE ps.plan_id = ? AND si.owner_id = ? AND si.state = 'available'
        AND (si.connection_id IS NULL OR (gc.status = 'active' AND si.generation = gc.generation))`).all(planId, memberId) as Array<{ source_id: string }>;
    return [...new Set(rows.map((row) => refForSource(`source:${row.source_id}`)))];
  }

  private coverage(actor: DailyContextActor, now: Date, omitted: Record<DailyCandidateKind, number>, omittedKnowledge: number): DailyCoverage[] {
    const calendarSelections = this.db.prepare(`SELECT cs.id, gc.status, ss.last_success_at
      FROM calendar_selections cs JOIN google_connections gc ON gc.id = cs.connection_id
      JOIN members m ON m.id = gc.member_id LEFT JOIN sync_states ss ON ss.connection_id = gc.id
        AND ss.source_kind = 'calendar' AND ss.stream_key = cs.id
      WHERE m.household_id = ? AND m.active = 1 AND cs.selected = 1`).all(actor.householdId) as Array<{ id: string; status: string; last_success_at: string | null }>;
    const selectedActiveCalendar = calendarSelections.filter((row) => row.status === 'active');
    const activeCalendar = selectedActiveCalendar.filter((row) => row.last_success_at);
    const calendarStatus = calendarSelections.length === 0 ? 'disabled' : selectedActiveCalendar.length !== calendarSelections.length ? 'unavailable' : activeCalendar.length !== selectedActiveCalendar.length ? 'unavailable' : aggregateSync(activeCalendar.map((row) => row.last_success_at), now);
    const email = this.db.prepare(`SELECT gc.status, ss.last_success_at FROM google_connections gc LEFT JOIN sync_states ss
      ON ss.connection_id = gc.id AND ss.source_kind = 'gmail' AND ss.stream_key = 'mailbox'
      WHERE gc.member_id = ?`).get(actor.memberId) as { status: string; last_success_at: string | null } | undefined;
    const emailStatus = !email ? 'disabled' : email.status !== 'active' || !email.last_success_at ? 'unavailable' : aggregateSync([email.last_success_at], now);
    return [
      { channel: 'calendar', status: omitted.calendar ? 'truncated' : calendarStatus, lastSuccessAt: latest(calendarSelections.filter((row) => row.status === 'active').map((row) => row.last_success_at)), omittedCount: omitted.calendar },
      { channel: 'email', status: omitted.source ? 'truncated' : emailStatus, lastSuccessAt: email?.last_success_at ?? null, omittedCount: omitted.source },
      { channel: 'plans', status: omitted.plan ? 'truncated' : 'fresh', lastSuccessAt: now.toISOString(), omittedCount: omitted.plan },
      { channel: 'tasks', status: omitted.task ? 'truncated' : 'fresh', lastSuccessAt: now.toISOString(), omittedCount: omitted.task },
      { channel: 'reminders', status: omitted.reminder ? 'truncated' : 'fresh', lastSuccessAt: now.toISOString(), omittedCount: omitted.reminder },
      { channel: 'knowledge', status: omittedKnowledge ? 'truncated' : 'fresh', lastSuccessAt: now.toISOString(), omittedCount: omittedKnowledge },
    ];
  }
}

export function dailyCalendarWindow(now: Date, timezone: string): CalendarDateWindow {
  const local = DateTime.fromJSDate(now).setZone(timezone);
  const start = local.startOf('day');
  const end = start.plus({ days: LOOKAHEAD_DAYS });
  return { startUtc: start.toUTC().toISO()!, endUtc: end.toUTC().toISO()!, startDate: start.toISODate()!, endDateExclusive: end.toISODate()! };
}

function trimKnowledge(knowledge: Array<{ key: string; value: string }>, personalPreferences: DailyContext['personalPreferences'] = []) {
  const originalCount = knowledge.length;
  while (estimateTokens({ personalPreferences, knowledge, candidates: [] }) > INPUT_TOKEN_LIMIT && knowledge.length) knowledge.pop();
  return originalCount - knowledge.length;
}

function estimateTokens(value: unknown) { return Math.ceil(JSON.stringify(value).length / 4) + PROMPT_TOKEN_RESERVE; }
function stripRank(candidate: RankedCandidate): DailyCandidate {
  return {
    ref: candidate.ref, kind: candidate.kind, title: candidate.title, ...(candidate.detail === undefined ? {} : {detail:candidate.detail}), normalizedTime: candidate.normalizedTime,
    state: candidate.state, revision: candidate.revision, generation: candidate.generation, sourceRefs: candidate.sourceRefs,
    navigation: candidate.navigation, required: candidate.required,
  };
}
function latest(values: Array<string | null>) { return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null; }
function aggregateSync(values: Array<string | null>, now: Date): DailyCoverageStatus { const dates = values.filter((value): value is string => Boolean(value)).map((value) => Date.parse(value)); return dates.length > 0 && dates.every((value) => now.getTime() - value <= 30 * 60 * 1000) ? 'fresh' : 'stale'; }
function timeSortAt(time: NormalizedTime | null, now: Date, timezone: string) {
  if (!time) return 0;
  if (time.kind === 'timed') return Date.parse(time.start);
  if (time.kind === 'deadline') return Date.parse(time.at);
  if (time.kind === 'all_day') return DateTime.fromISO(time.startDate, { zone: timezone }).toMillis();
  return time.startHint ? Date.parse(time.startHint) : now.getTime();
}
function timeRank(time: NormalizedTime, today: DateTime, lookahead: DateTime, overdue?: DateTime) {
  const day = { startUtc: today.toUTC().toISO()!, endUtc: today.plus({ days: 1 }).toUTC().toISO()!, startDate: today.toISODate()!, endDateExclusive: today.plus({ days: 1 }).toISODate()! };
  if (overdue && timeOverlaps(time, { startUtc: overdue.startOf('day').toUTC().toISO()!, endUtc: today.toUTC().toISO()!, startDate: overdue.toISODate()!, endDateExclusive: today.toISODate()! })) return 0;
  return timeOverlaps(time, day) ? 0 : timeOverlaps(time, { startUtc: today.toUTC().toISO()!, endUtc: lookahead.toUTC().toISO()!, startDate: today.toISODate()!, endDateExclusive: lookahead.toISODate()! }) ? 1 : 2;
}
function timeOverlaps(time: NormalizedTime, window: CalendarDateWindow) {
  if (time.kind === 'all_day') return time.startDate < window.endDateExclusive && time.endDateExclusive > window.startDate;
  if (time.kind === 'unresolved') return Boolean(time.dateHint && time.dateHint >= window.startDate && time.dateHint < window.endDateExclusive);
  const start = time.kind === 'deadline' ? Date.parse(time.at) : Date.parse(time.start);
  if (time.kind === 'deadline') return Number.isFinite(start) && start >= Date.parse(window.startUtc) && start < Date.parse(window.endUtc);
  const end = Date.parse(time.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < Date.parse(window.endUtc) && end > Date.parse(window.startUtc);
}
function listTime(raw: string, timezone: string): NormalizedTime | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return normalizedTimeSchema.parse({ kind: 'all_day', startDate: value, endDateExclusive: DateTime.fromISO(value, { zone: timezone }).plus({ days: 1 }).toISODate()! });
  const parsed = DateTime.fromISO(value, { setZone: /[zZ]|[+-]\d\d:?\d\d$/.test(value) }).setZone(timezone);
  return parsed.isValid ? normalizedTimeSchema.parse({ kind: 'deadline', at: parsed.toUTC().toISO({ suppressMilliseconds: true })!, timezone }) : null;
}
function deadlineTime(value: string, timezone: string) {
  const parsed = DateTime.fromISO(value, { setZone: true }).setZone(timezone);
  return normalizedTimeSchema.parse({ kind: 'deadline', at: parsed.toUTC().toISO({ suppressMilliseconds: true })!, timezone });
}
function reminderParent(row: { parent_type: string; parent_id: string }, plans: Map<string, PlanSummary>, db: Database.Database, householdId: string, sourceRefsForPlan: (planId: string) => string[]) {
  if (row.parent_type === 'plan') {
    const plan = plans.get(row.parent_id);
    if (!plan) return null;
    return { title: (plan.pendingFacts ?? plan.facts).title, sourceRefs: sourceRefsForPlan(plan.id) };
  }
  if (row.parent_type !== 'list_item') return null;
  const item = db.prepare('SELECT title FROM list_items WHERE id = ? AND household_id = ? AND completed_at IS NULL AND archived_at IS NULL').get(row.parent_id, householdId) as { title: string } | undefined;
  return item ? { title: item.title, sourceRefs: [] as string[] } : null;
}
function fallbackDetail(candidate: DailyCandidate, referenceDate: string, timezone: string) {
  if (candidate.normalizedTime?.kind === 'deadline') return `Due ${DateTime.fromISO(candidate.normalizedTime.at).setZone(timezone).toFormat('cccc, LLL d')}.`;
  if (candidate.normalizedTime?.kind === 'all_day') return candidate.normalizedTime.startDate === referenceDate ? 'Scheduled today.' : `Scheduled ${candidate.normalizedTime.startDate}.`;
  if (candidate.normalizedTime?.kind === 'timed') return `Scheduled ${DateTime.fromISO(candidate.normalizedTime.start).setZone(timezone).toFormat('cccc, LLL d at h:mm a')}.`;
  return candidate.kind === 'source' ? 'Recent source available for review.' : 'Actionable household item.';
}
