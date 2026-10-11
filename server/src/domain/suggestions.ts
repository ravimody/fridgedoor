import { randomBytes } from 'node:crypto';
import type { ExtractionResult } from '../providers/ai.js';
import type { PlanFacts } from '@fridgedoor/contracts';
import type { PlanRepository } from '../repos/plans.js';

export type SuggestionInput = { sourceVersionId: string; ownerId: string; householdId: string; result: ExtractionResult };
export class SuggestionService {
  constructor(private readonly plans: PlanRepository, private readonly onPlan?: (input:{ownerId:string;planId:string;sourceVersionId:string;candidate:ExtractionResult['candidates'][number]})=>void) {}
  ingest(input: SuggestionInput) {
    for (const candidate of input.result.candidates) {
      if (candidate.decision === 'exclude') continue;
      const visibility = candidate.decision === 'share_candidate' ? 'shared' : 'private';
      const planId=this.plans.upsertExtraction({ id: randomBytes(16).toString('hex'), ...input, visibility, facts: candidate.safeFacts as PlanFacts, relation: candidate.relation, evidenceRole: candidate.relation === 'cancel' ? 'cancellation' : 'supporting' });
      this.onPlan?.({ownerId:input.ownerId,planId,sourceVersionId:input.sourceVersionId,candidate});
    }
  }
}
