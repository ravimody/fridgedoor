import type { AppConfig } from '../config.js';
import type { LlmHub } from '../llm/hub.js';

export * from './ai-contracts.js';
import type { ExtractionResult, ExtractionPacket, AiResponse, AiProvider, EmailGateStore } from './ai-contracts.js';
import { ReviewedEmailProvider } from './reviewed-email.js';
import { LlmExtractionProvider } from './extraction.js';

const candidate = (packet: ExtractionPacket, decision: ExtractionResult['decision'], category: ExtractionResult['category']): ExtractionResult => { const mediaEvidence = packet.media?.length ? [{ field: 'title', kind: 'media' as const, mediaPageRegion: { page: 0, x: 0, y: 0, width: 1, height: 1 } }] : [{ field: 'title', kind: 'text' as const, textSpan: { start: 0, end: Math.min(packet.text.length, 80) } }]; return { decision, category, confidence: decision === 'share_candidate' ? 0.96 : 0.98, uncertaintyReasons: decision === 'private' ? ['Synthetic privacy fixture'] : [], privacyFlags: decision === 'exclude' ? ['work'] : decision === 'private' ? ['explicit_private'] : [], candidates: [{ decision, confidence: decision === 'share_candidate' ? 0.96 : 0.98, privacyFlags: decision === 'exclude' ? ['work'] : decision === 'private' ? ['explicit_private'] : [], kind: 'event', relation: 'new', safeFacts: { title: packet.text.slice(0, 80) || 'Household item', category, participants: packet.allowedParticipants.slice(0, 2), preparationTasks: [], unresolvedFields: ['date', 'start', 'end', 'timezone'] }, sourceEvidence: mediaEvidence, unresolvedFields: ['date', 'start', 'end', 'timezone'] }] }; };
export class FakeAiProvider implements AiProvider {
  calls = 0;
  constructor(private readonly model = 'synthetic-v1') {}
  async extract(packet: ExtractionPacket, _signal?: AbortSignal): Promise<AiResponse> { void _signal; this.calls += 1; const text = (packet.text || (packet.media?.length ? 'Attached household document' : '')).toLowerCase(); const excluded = text.includes('work-only') || (text.includes('work meeting') && !text.includes('school pickup') && !text.includes('household detail')); const privateReview = text.includes('private medical') || text.includes('medical') || text.includes('uncertain') || text.includes('ambiguous') || text.includes('mixed') || text.includes('work travel and family') || text.includes('work meeting and school') || text.includes('household detail'); const decision = excluded ? 'exclude' : privateReview ? 'private' : 'share_candidate'; const category = text.includes('school') ? 'school' : text.includes('travel') ? 'travel' : text.includes('medical') ? 'medical' : excluded ? 'work' : 'appointment'; return { result: candidate({ ...packet, text: packet.text || 'Attached household document' }, decision, category), usage: { inputTokens: packet.text.length }, provider: 'fake', model: this.model }; }
  async respondToChat(): Promise<never> { throw new Error('AI_CHAT_DISABLED'); }
}

/** True when background email reading may run: a model is configured and the AI_ENABLED kill switch is not off. */
export function backgroundAiEnabled(hub: LlmHub, config: Pick<AppConfig, 'AI_ENABLED'>) { return hub.configured() && config.AI_ENABLED !== 'false'; }

/**
 * Extraction through whichever provider and models are configured when each job runs.
 * It always reserves budget through `beforeAdditionalRequest`, so a settings change
 * between the reservation check and the request cannot skip the budget.
 */
class HubAiProvider implements AiProvider {
  readonly managesReservations = true;
  constructor(private readonly hub: LlmHub, private readonly effort: AppConfig['AI_EXTRACT_EFFORT']) {}
  async extract(packet: ExtractionPacket, signal: AbortSignal, beforeAdditionalRequest?: (model: string) => void, checkpoints?: EmailGateStore): Promise<AiResponse> {
    const config = this.hub.config();
    const model = this.hub.model('email');
    if (!config || !model) throw new Error('AI_NOT_CONFIGURED');
    if (config.provider === 'fake') { beforeAdditionalRequest?.(model); return new FakeAiProvider(model).extract(packet, signal); }
    const provider = this.hub.provider()!;
    const review = this.hub.model('review');
    // The email model screens every message (reading it closely, at high effort); the stronger review
    // model extracts the ones it passes. AI_EXTRACT_EFFORT sets the extraction effort in both setups.
    if (review) return new ReviewedEmailProvider(provider, model, new LlmExtractionProvider(provider, review, this.effort ?? 'low'), review).extract(packet, signal, beforeAdditionalRequest, checkpoints);
    beforeAdditionalRequest?.(model);
    return new LlmExtractionProvider(provider, model, this.effort).extract(packet, signal);
  }
  async respondToChat(): Promise<never> { throw new Error('AI_CHAT_NOT_IMPLEMENTED'); }
}

/** `AI_PROVIDER=fake` selects the deterministic fake for previews and tests. */
export function createAiProvider(hub: LlmHub, config: Pick<AppConfig, 'AI_EXTRACT_EFFORT'> = {}): AiProvider { return new HubAiProvider(hub, config.AI_EXTRACT_EFFORT); }
