/** Opt-in live evaluation. Only synthetic inputs; no production DB or writes. */
import { readFileSync } from 'node:fs';
import { LlmAgent, type AgentPacket } from './agent.js';
import { scriptAi } from '../settings.js';
const model = process.argv[2];
const hub = model ? scriptAi(model).hub : undefined;
if (!hub?.configured()) throw new Error('Model argument and AI_PROVIDER (plus AI_API_KEY for hosted providers) required');
const agent = new LlmAgent(hub);
const common: Omit<AgentPacket, 'text'> = { referenceTime: '2026-09-12T14:00:00Z', timezone: 'America/New_York', history: [], knowledge: [] };
const cases: { name: string; packet: AgentPacket }[] = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) as { name: string; packet: AgentPacket }[] : [
  { name: 'calendar', packet: { ...common, text: 'drinks with bob on monday at 6' } },
  { name: 'groceries', packet: { ...common, text: 'Add 2 cans of beans and a carton of oat milk to groceries' } },
  { name: 'context', packet: { ...common, text: 'What is on our grocery list?' } },
  { name: 'memory', packet: { ...common, text: 'Remember that we prefer vegetarian meals.' } },
  { name: 'poster', packet: { ...common, text: 'Help plan for this poster', media: { mimeType: 'image/png', base64: readFileSync(new URL('./fixtures/smoke-poster.png', import.meta.url)).toString('base64') } } },
];
for (const item of cases) {
  try {
    const output = await agent.run(item.packet, () => ({ groceries: [{ title: 'Apples', quantity: '6' }], todos: [], plans: [] }), AbortSignal.timeout(120000));
    console.info(JSON.stringify({ case: item.name, ...output }));
  } catch (error) { console.info(JSON.stringify({ case: item.name, error: error instanceof Error ? error.message : 'FAILED' })); process.exitCode = 1; }
}
