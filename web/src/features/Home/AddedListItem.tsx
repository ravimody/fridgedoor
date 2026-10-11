import type { AssistantRun } from '@fridgedoor/contracts';
import { post, usePlanner } from './PlannerContext.js';
export function AddedListItem({ run, index }: { run: AssistantRun; index: number }) {
  const planner = usePlanner(); const item = run.result?.items[index];
  const receipt = run.reviews?.find((entry) => entry.target === `item:${index}`);
  if (!item || !receipt?.automatic) return null;
  return <span>{receipt.undoneAt ? 'Undone: ' : 'Added '}{item.title}{!receipt.undoneAt && <button className="secondary" disabled={planner.busy} onClick={() => void planner.act(() => post(`/assistant/runs/${run.id}/undo`, { index }))}>Undo</button>}</span>;
}
