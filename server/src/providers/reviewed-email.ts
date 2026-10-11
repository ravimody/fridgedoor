import { DateTime } from 'luxon';
import { EMAIL_REVIEW_GUIDANCE } from '../ai/email-review-guidance.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RELEVANCE_GUIDANCE } from '../ai/relevance-guidance.js';
import type { LlmProvider } from '../llm/types.js';
import type { AiProvider, AiResponse, ExtractionPacket, EmailGateStore } from './ai-contracts.js';

const gateSchema = z.object({ decision: z.enum(['skip', 'review', 'uncertain']), confidence: z.enum(['high', 'medium', 'low']), reason: z.string().max(300) });
// Stable across retries; audit confident skips too, not just admitted uncertainty.
export function auditEmail(id: string) {
  return createHash('sha256').update(`email-review-v1:${id}`).digest().readUInt32BE(0) % 10 === 0;
}


const RETRYABLE = new Set(['AI_RETRYABLE', 'AI_RATE_LIMITED']);
const INCOMPLETE = new Set(['AI_OUTPUT_LIMIT', 'AI_OUTPUT_INCOMPLETE', 'AI_RESPONSE_FAILED']);
const UNREADABLE = new Set(['AI_OUTPUT_EMPTY', 'AI_OUTPUT_INVALID_JSON', 'AI_OUTPUT_SCHEMA_INVALID', 'AI_REFUSED']);

/**
 * Two-stage email reading: the `email` model screens every message, then the stronger
 * `review` model extracts the ones worth reading without seeing that verdict. Results
 * carry the email model's name, which keys extraction rows and budgets.
 */
export class ReviewedEmailProvider implements AiProvider {
  readonly managesReservations = true;
  constructor(private readonly gate: LlmProvider, private readonly model: string, private readonly extractor: AiProvider, private readonly extractModel: string) {}
  async extract(packet: ExtractionPacket, signal: AbortSignal, beforeAdditionalRequest?: (model: string) => void, checkpoints?: EmailGateStore): Promise<AiResponse> {
    const { media, ...descriptor } = packet;
    // Resume only with the same source, preferences, models, and local day.
    const { referenceTime, ...stablePacket } = packet;
    delete stablePacket.nextMorningReview;
    const checkpointKey = createHash('sha256').update(JSON.stringify({packet:stablePacket,provider:this.gate.id,model:this.model,extractModel:this.extractModel,date:DateTime.fromISO(referenceTime ?? new Date().toISOString()).setZone(packet.timezone).toISODate()})).digest('hex');
    let checkpoint = checkpoints?.load(checkpointKey);
    if (!checkpoint) {
      beforeAdditionalRequest?.(this.model);
      let gate;
      try {
        gate = await this.gate.generate({ model: this.model, reasoning: 'high', maxOutputTokens: 6000,
          system: `${RELEVANCE_GUIDANCE}\n${EMAIL_REVIEW_GUIDANCE}`,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ ...descriptor, hasUnreadMedia: Boolean(media?.length) }) }] }],
          schema: gateSchema, schemaName: 'email_relevance', signal,
        });
      } catch (error) {
        if (signal.aborted) { const canceled = new Error('AI_CANCELLED'); canceled.name = 'AbortError'; throw canceled; }
        const code = error instanceof Error ? error.message : '';
        throw new Error(RETRYABLE.has(code) ? 'AI_RETRYABLE' : INCOMPLETE.has(code) ? 'AI_OUTPUT_INCOMPLETE' : UNREADABLE.has(code) ? 'AI_OUTPUT_SCHEMA_INVALID' : 'AI_PROVIDER_FAILED');
      }
      if (gate.type !== 'object') throw new Error('AI_OUTPUT_SCHEMA_INVALID');
      const value = gate.object;
      const reviewReason = media?.length || packet.truncated ? 'incomplete' : value.decision !== 'skip' ? value.decision : value.confidence !== 'high' ? 'uncertain' : auditEmail(packet.sourceVersionId) ? 'skip_audit' : 'skip';
      const first = { model: this.model, inputTokens: gate.usage.inputTokens, outputTokens: gate.usage.outputTokens, reasoningTokens: gate.usage.reasoningTokens ?? 0, providerRequestId: gate.requestId ?? '' };
      checkpoint = {reviewReason, usage:first};
      checkpoints?.save(checkpointKey, checkpoint);
    }
    const {reviewReason, usage:first} = checkpoint;
    if (reviewReason === 'skip') return { provider: this.gate.id, model: this.model,
      result: { decision: 'exclude', category: 'other', confidence: 1, uncertaintyReasons: [], privacyFlags: [], candidates: [] },
      usage: { inputTokens: first.inputTokens, outputTokens: first.outputTokens, stages: [first], reviewReason } };
    beforeAdditionalRequest?.(this.extractModel);
    // Independent source judgment: no gate verdict or rationale is passed to extraction.
    const extracted = await this.extractor.extract(packet, signal);
    if (extracted.model !== this.extractModel) throw new Error('AI_MODEL_MISMATCH');
    const second = { model: extracted.model, inputTokens: extracted.usage.inputTokens ?? 0, outputTokens: extracted.usage.outputTokens ?? 0, reasoningTokens: extracted.usage.reasoningTokens ?? 0, providerRequestId: extracted.usage.providerRequestId ?? '' };
    return { ...extracted, model: this.model, usage: { inputTokens: first.inputTokens + second.inputTokens, outputTokens: first.outputTokens + second.outputTokens, stages: [first, second], reviewReason } };
  }
  async respondToChat(): Promise<never> { throw new Error('AI_CHAT_NOT_IMPLEMENTED'); }
}
