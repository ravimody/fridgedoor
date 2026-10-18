/** Synthetic, write-free evaluation for the daily assistant and relevance packet. */
import { writeFileSync } from 'node:fs';
import { FakeAiProvider, type ExtractionPacket } from '../providers/ai.js';
import { projectPolicy } from './policy.js';

type Case = { name: string; text: string; expected: 'share_candidate'|'private'|'exclude'; knowledge?: NonNullable<ExtractionPacket['knowledge']> };
const common = { schemaVersion: 'extract-v1', timezone: 'America/New_York', ownerLabel: 'Synthetic owner', allowedParticipants: ['Synthetic owner'], allowedCategories: ['school', 'travel', 'appointment', 'optional', 'work', 'medical', 'other'], truncated: false } as const;
const cases: Case[] = [
  { name: 'School clothing instruction due today', text: 'School clothing instruction: bring a blue shirt today.', expected: 'share_candidate', knowledge: [{ key: 'school_name', value: 'Maple Grove Elementary', revision: 2, provenance: 'user', confirmation: 'confirmed', validity: 'current', validFrom: null, validUntil: null }] },
  { name: 'Form due in several days requires booking', text: 'School form due Friday; schedule the required appointment first.', expected: 'share_candidate' },
  { name: 'District bulletin with mixed age groups', text: 'Mixed district bulletin for elementary and senior students.', expected: 'private' },
  { name: 'Photo-only classroom notification', text: '', expected: 'share_candidate' },
  { name: 'Explicitly obsolete monthly reminder', text: 'Old monthly school reminder; no new action is stated.', expected: 'share_candidate' },
  { name: 'Optional parking-release reminder', text: 'Optional parking release reminder for the school event.', expected: 'share_candidate' },
  { name: 'Art class time changes next week', text: 'Art class time changes next week.', expected: 'share_candidate' },
  { name: 'No-school exception', text: 'No school on Monday because of a holiday.', expected: 'share_candidate' },
  { name: 'Parent work flexibility', text: 'Work-only note: parent has flexible hours and may help.', expected: 'exclude' },
  { name: 'Weekend chores routine', text: 'The usual weekend chores routine is mentioned.', expected: 'share_candidate' },
  { name: 'Future school transition', text: 'School transition begins next September.', expected: 'share_candidate', knowledge: [{ key: 'school_next_year', value: 'Maple Grove Middle School', revision: 1, provenance: 'user', confirmation: 'confirmed', validity: 'future', validFrom: '2027-09-01', validUntil: null }] },
  { name: 'Confirmed allergy precaution versus vague source', text: 'Private medical allergy precaution is confirmed.', expected: 'private', knowledge: [{ key: 'allergy_precaution', value: 'Avoid shellfish', revision: 3, provenance: 'user', confirmation: 'confirmed', validity: 'current', validFrom: null, validUntil: null }] },
  { name: 'Calendar invite duplicates real event', text: 'School calendar invite for the household event.', expected: 'share_candidate' },
  { name: 'Completed and dismissed mixed proposal', text: 'School item mixed with a completed reminder.', expected: 'private' },
  { name: "Other owner's private email and fact", text: 'Mixed private household details from another owner.', expected: 'private' },
  { name: 'Provider failure and expired evidence', text: 'Expired source evidence cannot be used.', expected: 'share_candidate' },
  { name: 'Midnight DST and delayed job', text: 'School pickup crosses a daylight saving time boundary.', expected: 'share_candidate' },
  { name: 'Conflict in durable fact', text: 'Ambiguous school identity needs a focused question.', expected: 'private' },
  { name: 'Forgotten fact in old evidence', text: 'Uncertain old source repeats a forgotten dietary fact.', expected: 'private' },
  { name: 'Concurrent edit and retry', text: 'School correction remains available for review after a retry.', expected: 'share_candidate' },
];

function packet(item: Case, attempt: number): ExtractionPacket { return { ...common, allowedParticipants: [...common.allowedParticipants], allowedCategories: [...common.allowedCategories], sourceVersionId: `synthetic-${attempt}`, text: item.text, knowledge: item.knowledge ?? [] }; }
function evaluate(item: Case) {
  const outputs = [0, 1, 2].map((attempt) => new FakeAiProvider().extract(packet(item, attempt), new AbortController().signal).then((value) => projectPolicy(value.result, { excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false }, { labels: [] })));
  return Promise.all(outputs).then((results) => {
    const decisions = results.map((result) => result.decision);
    return { stable: decisions.every((decision) => decision === decisions[0]), noInventedTime: results.every((result) => result.candidates.every((candidate) => candidate.safeFacts.time === undefined)), expected: decisions[0] === item.expected, decision: decisions[0] };
  });
}

const rows = await Promise.all(cases.map(async (item) => ({ item, result: await evaluate(item) })));
const passed = rows.filter(({ result }) => result.stable && result.noInventedTime && result.expected).length;
const report = ['# Daily assistant synthetic evaluation', '', `Cases: ${rows.length}`, `Pass: ${passed}`, `Stable runs: ${rows.filter(({ result }) => result.stable).length}/${rows.length}`, `No invented times: ${rows.filter(({ result }) => result.noInventedTime).length}/${rows.length}`, '', '| Case | Expected policy | Observed | Stable x3 | No invented time | Result |', '| --- | --- | --- | --- | --- | --- |', ...rows.map(({ item, result }) => `| ${item.name} | ${item.expected} | ${result.decision} | ${result.stable ? 'yes' : 'no'} | ${result.noInventedTime ? 'yes' : 'no'} | ${result.stable && result.noInventedTime && result.expected ? 'pass' : 'review'} |`), '', 'This report uses synthetic text and the deterministic fake provider. It does not evaluate a live model, access a production database, or send data to a provider.'].join('\n');
const output = process.argv[2];
if (output) writeFileSync(output, `${report}\n`); else console.log(report);
