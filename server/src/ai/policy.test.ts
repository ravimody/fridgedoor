import { describe, expect, it } from 'vitest';
import { projectPolicy, shareableCandidates, validateEvidence } from './policy.js';
import { FakeAiProvider, type ExtractionPacket } from '../providers/ai.js';

const packet: ExtractionPacket = { schemaVersion: 'extract-v1', sourceVersionId: 'v1', timezone: 'America/New_York', ownerLabel: 'Alex', allowedParticipants: ['Alex'], allowedCategories: ['school'], text: 'School pickup at the library', truncated: false };
describe('AI sharing policy', () => {
  it('keeps work-only candidates out of shared output', async () => { const response = await new FakeAiProvider().extract({ ...packet, text: 'work-only meeting' }, new AbortController().signal); const result = projectPolicy(response.result, { excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false }, { labels: [], sender: 'work@example.test' }); expect(result.decision).toBe('exclude'); expect(shareableCandidates(result)).toHaveLength(0); });
  it('sanitizes an opted-in medical candidate to generic logistics', async () => { const response = await new FakeAiProvider().extract({ ...packet, text: 'medical appointment' }, new AbortController().signal); const result = projectPolicy(response.result, { excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: true }, { labels: [] }); const candidate = result.candidates[0]!; expect(candidate.safeFacts.title).toBe('Appointment'); expect(candidate.safeFacts.notes).toBeUndefined(); });
  it('keeps incomplete media owner-only and bounds media regions', async () => { const mediaPacket: ExtractionPacket = { ...packet, text: '', truncated: true, media: [{ kind: 'pdf', mimeType: 'application/pdf', dataBase64: 'JVBERi0xLjcK', pageCount: 1 }] }; const response = await new FakeAiProvider().extract(mediaPacket, new AbortController().signal); const result = projectPolicy(response.result, { excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false }, { labels: [], incomplete: true }); expect(result.candidates[0]?.decision).toBe('private'); expect(() => validateEvidence(response.result, { ...mediaPacket, media: [{ ...mediaPacket.media![0]!, pageCount: 0 }] })).toThrow('AI_MEDIA_EVIDENCE_OUT_OF_BOUNDS'); });
  it('rejects text spans outside the packet', async () => { const response = await new FakeAiProvider().extract(packet, new AbortController().signal); response.result.candidates[0]!.sourceEvidence[0]!.textSpan = { start: 0, end: packet.text.length + 1 }; expect(() => validateEvidence(response.result, packet)).toThrow('AI_EVIDENCE_OUT_OF_BOUNDS'); });
});
it('accepts only fresh source-backed urgency and never makes a deadline from it',async()=>{
  const current={...packet,referenceTime:'2026-09-19T14:00:00Z',sourceTime:'2026-09-19T13:55:00Z',nextMorningReview:'2026-09-20T11:00:00Z'};
  const output=(await new FakeAiProvider().extract(current)).result;
  output.candidates[0]!.attention={kind:'coordination',reason:'A response is needed today.',evidenceQuote:packet.text};
  validateEvidence(output,current);expect(output.candidates[0]!.attention).toBeDefined();expect(output.candidates[0]!.safeFacts.time).toBeUndefined();
  const bad=structuredClone(output);bad.candidates[0]!.attention!.evidenceQuote='Invented urgency';
  validateEvidence(bad,current);expect(bad.candidates[0]!.attention).toBeUndefined();expect(bad.candidates[0]!.safeFacts.title).toBe(output.candidates[0]!.safeFacts.title);
  for(const sourceTime of ['2026-09-17T14:00:00Z','2026-09-20T14:00:00Z','invalid']) {
    const stale=structuredClone(output);validateEvidence(stale,{...current,sourceTime});expect(stale.candidates[0]!.attention).toBeUndefined();
  }
  const incomplete=structuredClone(output);validateEvidence(incomplete,{...current,truncated:true});expect(incomplete.candidates[0]!.attention).toBeUndefined();
});

describe('privacy flags', () => {
  const shareable = async () => { const response = await new FakeAiProvider().extract(packet, new AbortController().signal); const result = structuredClone(response.result); result.decision = 'share_candidate'; result.confidence = 0.95; result.uncertaintyReasons = []; result.privacyFlags = []; result.category = 'school'; for (const candidate of result.candidates) { candidate.decision = 'share_candidate'; candidate.confidence = 0.95; candidate.privacyFlags = []; } return result; };
  const policy = (optIn: boolean) => ({ excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: optIn });
  it('keeps a candidate private when only the candidate carries a privacy flag', async () => {
    const result = await shareable(); expect(projectPolicy(result, policy(false), { labels: [] }).candidates[0]!.decision).toBe('share_candidate');
    result.candidates[0]!.privacyFlags = ['explicit_private'];
    expect(projectPolicy(result, policy(false), { labels: [] }).candidates[0]!.decision).toBe('private');
  });
  it('treats a candidate-level medical flag as medical', async () => {
    const result = await shareable(); result.candidates[0]!.privacyFlags = ['medical'];
    expect(projectPolicy(result, policy(false), { labels: [] }).candidates[0]).toMatchObject({ decision: 'private' });
    expect(projectPolicy(result, policy(true), { labels: [] }).candidates[0]).toMatchObject({ decision: 'share_candidate', safeFacts: { title: 'Appointment' } });
  });
  it('lets the medical opt-in share generic logistics even when the result is flagged medical', async () => {
    const result = await shareable(); result.category = 'medical'; result.privacyFlags = ['medical'];
    expect(projectPolicy(result, policy(true), { labels: [] }).candidates[0]).toMatchObject({ decision: 'share_candidate', safeFacts: { title: 'Appointment' } });
    expect(projectPolicy(result, policy(false), { labels: [] }).candidates[0]!.decision).toBe('private');
    result.privacyFlags = ['medical', 'explicit_private'];
    expect(projectPolicy(result, policy(true), { labels: [] }).candidates[0]!.decision).toBe('private');
  });
});
