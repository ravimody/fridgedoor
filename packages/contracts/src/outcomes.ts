import type { AssistantRun } from './assistant.js';
import type { PlanSummary } from './plans.js';
export const outcomeLabels = {
  working: 'Working…', calendar_pending: 'Waiting for Google Calendar', needs_attention: 'Needs attention', needs_review: 'Needs review',
  added: 'Added to household lists', saved: 'Saved in planner', calendar_added: 'Added to Google Calendar', calendar_updated: 'Updated in Google Calendar', calendar_removed: 'Removed from Google Calendar',
  remembered: 'Knowledge updated', undone: 'Undone', dismissed: 'Dismissed', reply: 'Reply ready',
} as const;
export type Outcome = keyof typeof outcomeLabels;
export function calendarOutcome(action: { state: string; kind?: string | undefined }): Outcome {
  if (action.state === 'succeeded') return action.kind === 'cancel' ? 'calendar_removed' : action.kind === 'update' ? 'calendar_updated' : 'calendar_added';
  return ['failed','conflict','needs_reauth','canceled'].includes(action.state) ? 'needs_attention' : 'calendar_pending';
}
export function requestOutcomes(run: AssistantRun, plans: readonly PlanSummary[] = []): Outcome[] {
  if (['queued','running'].includes(run.state)) return ['working'];
  if (run.state !== 'succeeded' || !run.result) return ['needs_attention'];
  const outcomes = new Set<Outcome>();
  run.result.items.forEach((item, index) => {
    const review = run.reviews?.find((entry) => entry.target === `item:${index}`);
    if (!review) { outcomes.add('needs_review'); return; }
    if (review.undoneAt) { outcomes.add('undone'); return; }
    if (review.state === 'dismissed') { outcomes.add('dismissed'); return; }
    if (item.kind !== 'event') { outcomes.add(review.state === 'saved' ? 'added' : 'needs_review'); return; }
    const plan = plans.find((entry) => entry.id === review.planId);
    const action = plan?.calendarAction ?? review.calendarAction;
    if (action) {
      outcomes.add(calendarOutcome(action));
      if (plan?.pendingFacts && action.state === 'succeeded') outcomes.add('needs_review');
    } else if (plan?.status === 'dismissed' || plan?.status === 'archived') outcomes.add('dismissed');
    else if (plan?.savedInPlanner || review.state === 'kept') outcomes.add('saved');
    else outcomes.add(review.state === 'calendar' ? 'calendar_pending' : 'needs_review');
  });
  run.result.knowledge.forEach((_, index) => {
    const review = run.reviews?.find((entry) => entry.target === `knowledge:${index}`);
    outcomes.add(!review ? 'needs_review' : review.state === 'dismissed' ? 'dismissed' : 'remembered');
  });
  if (!outcomes.size) outcomes.add('reply');
  const priority: Outcome[] = ['needs_attention','needs_review','calendar_pending','working','added','saved','calendar_added','calendar_updated','calendar_removed','remembered','undone','dismissed','reply'];
  return priority.filter((outcome) => outcomes.has(outcome));
}
