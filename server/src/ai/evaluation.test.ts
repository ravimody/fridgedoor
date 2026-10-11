import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeAiProvider, type ExtractionPacket } from '../providers/ai.js';
import { projectPolicy, shareableCandidates } from './policy.js';

type Fixture = { id: string; category: string; text: string; expected: 'share_candidate' | 'private' | 'exclude' };
const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL('../../test/fixtures/privacy-fixtures.json', import.meta.url)), 'utf8')) as Fixture[];
const packet = (fixture: Fixture): ExtractionPacket => ({ schemaVersion: 'extract-v1', sourceVersionId: fixture.id, timezone: 'America/New_York', ownerLabel: 'Synthetic owner', allowedParticipants: ['Synthetic owner'], allowedCategories: ['school', 'travel', 'appointment', 'optional', 'work', 'medical', 'other'], text: fixture.text, truncated: false });

describe('privacy fixture evaluation', () => {
  it('covers every policy fixture with no private/work leakage or invented dates', async () => {
    const provider = new FakeAiProvider();
    const observed = new Map<string, string>();
    for (const fixture of fixtures) {
      const response = await provider.extract(packet(fixture), new AbortController().signal);
      const projected = projectPolicy(response.result, { excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false }, { labels: [] });
      observed.set(fixture.category, projected.decision);
      expect(projected.decision).toBe(fixture.expected);
      const shareable = shareableCandidates(projected);
      if (fixture.expected !== 'share_candidate') expect(shareable).toHaveLength(0);
      for (const candidate of shareable) {
        expect(candidate.safeFacts.time).toBeUndefined();
        expect(candidate.safeFacts.unresolvedFields).toEqual(expect.arrayContaining(['date', 'start', 'end', 'timezone']));
      }
    }
    expect(observed.size).toBe(12);
    expect(provider.calls).toBe(fixtures.length);
  });
});
