import { extractionResultSchema, EXTRACTION_PROMPT_VERSION, type ExtractionPacket, type ExtractionResult } from '../providers/ai.js';

export const POLICY_VERSION = 'privacy-v1';
export const PROMPT_VERSION = EXTRACTION_PROMPT_VERSION;
const threshold = 0.9;
export type SourcePolicyInput = { excludedSenders: string[]; excludedLabels: string[]; genericAppointmentOptIn: boolean };
export function validateEvidence(result: ExtractionResult, packet: ExtractionPacket) {
  for(const candidate of result.candidates) {
    // An urgency claim the email doesn't support is dropped; the suggestion itself still stands.
    if(candidate.attention && !packet.text.includes(candidate.attention.evidenceQuote)) delete candidate.attention;
    if(candidate.attention && (!packet.referenceTime || !packet.nextMorningReview || !packet.sourceTime || ![packet.referenceTime,packet.nextMorningReview,packet.sourceTime].every(value=>Number.isFinite(Date.parse(value))) || Date.parse(packet.sourceTime)>Date.parse(packet.referenceTime)+300000 || Date.parse(packet.referenceTime)-Date.parse(packet.sourceTime)>86400000 || Date.parse(packet.nextMorningReview)<=Date.parse(packet.referenceTime) || packet.truncated)) delete candidate.attention;
  }
  for (const candidate of result.candidates) for (const evidence of candidate.sourceEvidence) {
    if (evidence.kind === 'text') { if (!evidence.textSpan || evidence.textSpan.end < evidence.textSpan.start || evidence.textSpan.end > packet.text.length) throw new Error('AI_EVIDENCE_OUT_OF_BOUNDS'); }
    if (evidence.kind === 'media') { const region = evidence.mediaPageRegion; const pageCount = (packet.media ?? []).reduce((total, media) => total + (media.kind === 'pdf' ? (media.pageCount ?? 0) : 1), 0); if (!region || pageCount === 0 || region.page >= pageCount || region.x + region.width > 1 || region.y + region.height > 1) throw new Error('AI_MEDIA_EVIDENCE_OUT_OF_BOUNDS'); }
  }
}
export function projectPolicy(result: ExtractionResult, source: SourcePolicyInput, sourceMeta: { sender?: string; labels: string[]; incomplete?: boolean }): ExtractionResult {
  const senderExcluded = sourceMeta.sender ? source.excludedSenders.some((value) => value.toLowerCase() === sourceMeta.sender?.toLowerCase()) : false;
  const labelExcluded = sourceMeta.labels.some((label) => source.excludedLabels.includes(label));
  const candidates = result.candidates.map((candidate) => {
    let decision = candidate.decision; let privacyFlags = [...candidate.privacyFlags];
    // A flag on the candidate counts as much as one on the whole result.
    const flags = new Set([...result.privacyFlags, ...candidate.privacyFlags]);
    const medical = result.category === 'medical' || flags.has('medical');
    // The medical opt-in shares generic logistics: being medical alone then doesn't make an item private.
    const sharedMedical = medical && source.genericAppointmentOptIn;
    const blocking = [...flags].some((flag) => flag !== 'incomplete' && !(sharedMedical && flag === 'medical'));
    if (senderExcluded || labelExcluded || result.category === 'work' || flags.has('work')) { decision = 'exclude'; privacyFlags = [...new Set([...privacyFlags, 'work'])]; }
    else if (medical && !source.genericAppointmentOptIn) { decision = 'private'; privacyFlags = [...new Set([...privacyFlags, 'medical'])]; }
    else if (sourceMeta.incomplete && decision === 'share_candidate') { decision = 'private'; privacyFlags = [...new Set([...privacyFlags, 'incomplete'])]; }
    else if (decision === 'share_candidate' && (candidate.confidence < threshold || result.confidence < threshold || result.uncertaintyReasons.length > 0 || blocking)) { decision = 'private'; privacyFlags = [...new Set([...privacyFlags, 'uncertain'])]; }
    const safeFacts = sharedMedical ? (() => { const facts = JSON.parse(JSON.stringify(candidate.safeFacts)) as typeof candidate.safeFacts; delete facts.notes; facts.title = 'Appointment'; return facts; })() : candidate.safeFacts;
    return { ...candidate, decision, privacyFlags, safeFacts };
  });
  const rootDecision = candidates.some((candidate) => candidate.decision === 'share_candidate') ? 'share_candidate' : candidates.some((candidate) => candidate.decision === 'private') ? 'private' : 'exclude';
  return extractionResultSchema.parse({ ...result, decision: rootDecision, candidates });
}
export function shareableCandidates(result: ExtractionResult) { return result.candidates.filter((candidate) => candidate.decision === 'share_candidate' && candidate.confidence >= threshold).map(({ safeFacts, kind, relation }) => ({ safeFacts, kind, relation })); }
