import { digest } from '../crypto.js';
import { planFactsSchema, type PlanFacts } from '@fridgedoor/contracts';

export const normalizedTitle = (title: string) => title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
export const factsMaterial = (facts: PlanFacts) => ({ title: normalizedTitle(facts.title), category: facts.category, participants: [...facts.participants].sort(), time: facts.time ?? null, location: facts.location?.toLocaleLowerCase().trim() ?? null, notes: facts.notes ?? null, preparationTasks: [...facts.preparationTasks].sort(), unresolvedFields: [...facts.unresolvedFields].sort() });
export const materialFingerprint = (facts: PlanFacts) => digest(JSON.stringify(factsMaterial(planFactsSchema.parse(facts))));
export const dateKey = (facts: PlanFacts) => facts.time?.kind === 'timed' ? facts.time.start.slice(0, 10) : facts.time?.kind === 'deadline' ? facts.time.at.slice(0, 10) : facts.time?.kind === 'all_day' ? facts.time.startDate : facts.time?.kind === 'unresolved' ? facts.time.dateHint ?? null : null;
export type MatchRow = { id: string; visibility: 'shared'|'private'; ownerId: string | null; title: string; materialFingerprint: string; dateKey: string | null };
export type Match = { kind: 'exact'|'possible'|'none'; planId?: string };
export function matchPlan(facts: PlanFacts, candidateVisibility: 'shared'|'private', ownerId: string | null, rows: MatchRow[]): Match {
  const fingerprint = materialFingerprint(facts); const title = normalizedTitle(facts.title); const date = dateKey(facts);
  const exact = rows.find((row) => row.visibility === candidateVisibility && row.ownerId === ownerId && row.materialFingerprint === fingerprint);
  if (exact) return { kind: 'exact', planId: exact.id };
  const possible = rows.find((row) => row.visibility === candidateVisibility && row.ownerId === ownerId && normalizedTitle(row.title) === title && row.dateKey === date && date !== null);
  return possible ? { kind: 'possible', planId: possible.id } : { kind: 'none' };
}
