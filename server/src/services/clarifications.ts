import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { decryptJson, encryptJson, indexKey, type Envelope } from '../crypto.js';
import { DailyContextService, type DailyContext, type DailyContextActor } from './daily-context.js';
import type { DailyOverview } from '@fridgedoor/contracts';

type Clock = () => Date;
type CandidateSnapshot = { ref: string; navigation: { kind: string; id: string }; sourceRefs: string[]; revision: number | null; generation: number | null; state: string };
type Manifest = { refs: string[]; candidates: CandidateSnapshot[] };
type Row = { id: string; owner_id: string; encrypted_question: string; encrypted_reason: string; encrypted_source_manifest: string; dedupe_key: string; target_key: string; expected_target_revision: number; state: 'open'|'answered'|'dismissed'|'expired'; encrypted_answer: string | null; revision: number; created_at: string; updated_at: string; expires_at: string };
export type ClarificationView = { id: string; question: string; reason: string; sourceRefs: string[]; state: 'open'|'answered'|'dismissed'|'expired'; answer: string | null; revision: number; createdAt: string; expiresAt: string };

export class ClarificationService {
  constructor(private readonly db: Database.Database, private readonly key: Buffer, private readonly clock: Clock = () => new Date()) {}

  syncFromOverview(actor: DailyContextActor, overview: DailyOverview, context: DailyContext) {
    const current = new Map(context.candidates.map((candidate) => [candidate.ref, candidate]));
    const now = this.clock();
    for (const question of overview.questions) {
      const candidates = question.refs.map((ref) => current.get(ref)).filter((candidate): candidate is DailyContext['candidates'][number] => Boolean(candidate));
      if (candidates.length !== question.refs.length) continue;
      const snapshot = candidates.map(({ ref, navigation, sourceRefs, revision, generation, state }) => ({ ref, navigation, sourceRefs, revision, generation, state }));
      const targetRelation = JSON.stringify(snapshot.map(({ navigation }) => navigation).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
      const targetKey = indexKey(targetRelation, this.key);
      const sourceRefs = [...new Set(snapshot.flatMap((candidate) => candidate.sourceRefs))].sort();
      const dedupeKey = indexKey(JSON.stringify({ targetKey, sourceRefs, revisions: snapshot.map((candidate) => [candidate.revision, candidate.generation]).sort() }), this.key);
      if ((this.db.prepare("SELECT COUNT(*) AS count FROM clarifications WHERE owner_id = ? AND state = 'open'").get(actor.memberId) as { count: number }).count >= 5) break;
      if (this.db.prepare('SELECT 1 FROM clarifications WHERE owner_id = ? AND dedupe_key = ?').get(actor.memberId, dedupeKey)) continue;
      const id = randomBytes(16).toString('hex'); const timestamp = now.toISOString(); const targetRevision = Math.max(0, ...candidates.map((candidate) => candidate.revision ?? 0));
      const manifest: Manifest = { refs: question.refs, candidates: snapshot };
      this.db.prepare(`INSERT INTO clarifications (id, owner_id, encrypted_question, encrypted_reason, encrypted_source_manifest, dedupe_key, target_key, expected_target_revision, state, encrypted_answer, revision, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 1, ?, ?, ?)`).run(id, actor.memberId,
        JSON.stringify(encryptJson(question.text, this.key, `clarification-question:${id}`)),
        JSON.stringify(encryptJson(question.reason, this.key, `clarification-reason:${id}`)),
        JSON.stringify(encryptJson(manifest, this.key, `clarification-manifest:${id}`)), dedupeKey, targetKey, targetRevision, timestamp, timestamp, new Date(now.getTime() + 30 * 86400000).toISOString());
    }
  }

  list(actor: DailyContextActor): ClarificationView[] {
    this.member(actor);
    const context = this.context(actor);
    return (this.db.prepare("SELECT * FROM clarifications WHERE owner_id = ? AND state IN ('open','answered') AND expires_at > ? ORDER BY created_at").all(actor.memberId, this.clock().toISOString()) as Row[]).flatMap((row) => {
      const manifest = this.manifest(row);
      if (!this.current(manifest, context)) {
        this.db.prepare("UPDATE clarifications SET state = 'expired', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state IN ('open','answered')").run(this.clock().toISOString(), row.id, row.revision);
        return [];
      }
      return [this.view(row, manifest)];
    });
  }

  answer(actor: DailyContextActor, id: string, text: string, expectedRevision: number) {
    return this.mutate(actor, id, expectedRevision, (row) => {
      if (row.state !== 'open') throw new Error('CLARIFICATION_UNAVAILABLE');
      if (!text.trim() || text.length > 500) throw new Error('VALIDATION');
      const now = this.clock().toISOString();
      this.db.prepare("UPDATE clarifications SET state = 'answered', encrypted_answer = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ? AND state = 'open'").run(JSON.stringify(encryptJson(text.trim(), this.key, `clarification-answer:${id}`)), now, id, actor.memberId, expectedRevision);
      return this.get(actor, id)!;
    });
  }

  dismiss(actor: DailyContextActor, id: string, expectedRevision: number) {
    return this.mutate(actor, id, expectedRevision, (row) => {
      if (row.state !== 'open') throw new Error('CLARIFICATION_UNAVAILABLE');
      this.db.prepare("UPDATE clarifications SET state = 'dismissed', revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ? AND state = 'open'").run(this.clock().toISOString(), id, actor.memberId, expectedRevision);
      return this.get(actor, id)!;
    });
  }

  private mutate<T>(actor: DailyContextActor, id: string, expectedRevision: number, callback: (row: Row) => T) {
    this.member(actor); const row = this.db.prepare('SELECT * FROM clarifications WHERE id = ? AND owner_id = ?').get(id, actor.memberId) as Row | undefined;
    if (!row) throw new Error('NOT_FOUND');
    if (row.revision !== expectedRevision) throw new Error('STALE_REVISION');
    if (!this.current(this.manifest(row), this.context(actor))) throw new Error('CLARIFICATION_UNAVAILABLE');
    return callback(row);
  }

  private get(actor: DailyContextActor, id: string) {
    const row = this.db.prepare('SELECT * FROM clarifications WHERE id = ? AND owner_id = ?').get(id, actor.memberId) as Row | undefined;
    return row ? this.view(row, this.manifest(row)) : undefined;
  }

  private view(row: Row, manifest: Manifest): ClarificationView {
    return { id: row.id, question: decryptJson<string>(JSON.parse(row.encrypted_question) as Envelope, this.key, `clarification-question:${row.id}`), reason: decryptJson<string>(JSON.parse(row.encrypted_reason) as Envelope, this.key, `clarification-reason:${row.id}`), sourceRefs: manifest.candidates.flatMap((candidate) => candidate.sourceRefs).filter((ref, index, refs) => refs.indexOf(ref) === index), state: row.state, answer: row.encrypted_answer ? decryptJson<string>(JSON.parse(row.encrypted_answer) as Envelope, this.key, `clarification-answer:${row.id}`) : null, revision: row.revision, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  private current(manifest: Manifest, context: DailyContext) {
    const byRef = new Map(context.candidates.map((candidate) => [candidate.ref, candidate]));
    return manifest.refs.every((ref) => byRef.has(ref)) && manifest.candidates.every((saved) => {
      const current = context.candidates.find((candidate) => candidate.navigation.kind === saved.navigation.kind && candidate.navigation.id === saved.navigation.id);
      return Boolean(current && JSON.stringify({ sourceRefs: current.sourceRefs, revision: current.revision, generation: current.generation, state: current.state }) === JSON.stringify({ sourceRefs: saved.sourceRefs, revision: saved.revision, generation: saved.generation, state: saved.state }));
    });
  }

  private context(actor: DailyContextActor) {
    return new DailyContextService(this.db, this.key, this.clock).build(actor);
  }

  private manifest(row: Row) { return decryptJson<Manifest>(JSON.parse(row.encrypted_source_manifest) as Envelope, this.key, `clarification-manifest:${row.id}`); }
  private member(actor: DailyContextActor) { if (!this.db.prepare('SELECT 1 FROM members WHERE id = ? AND household_id = ? AND active = 1').get(actor.memberId, actor.householdId)) throw new Error('NOT_FOUND'); }
}
