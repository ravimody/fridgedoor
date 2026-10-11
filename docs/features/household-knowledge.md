# Household knowledge

Household knowledge is a short list of facts the planner should remember about your
household: "Alex's school pickup is at 3:15", "we're vegetarian on weekdays",
"swimming lessons are on Tuesdays". The planner uses them to make better
suggestions, for example placing a flyer's event at the right school without the
address printed on it.

The web app calls this **Household knowledge** (in More); the iPhone app calls it
**Household facts**.

## Private to you

Facts are private to the person who saved them. Other household members don't see
your facts, and the planner only uses your facts when working for you. They're
stored encrypted on your server.

## Adding and changing facts

- **Add or edit** a fact directly: a short name ("Dietary preference") and the
  details. You don't need AI turned on to manage facts.
- **Tell the planner**: "remember that soccer practice moved to Thursdays". The
  planner proposes the fact, and nothing is saved until you choose **Save**. Saving
  marks the fact as confirmed by you.
- **Search** the list by name or content.
- **Include dates** in the text when something changes: "Starts at Maple Grove
  Middle School on Sept 2". The planner reads the dates; Fridgedoor doesn't schedule
  the change for you.

Each person can keep up to 50 facts. A fact name can be up to 80 characters and the
details up to 500.

If the same fact was changed on another device since you opened it, your edit is
refused instead of silently overwriting it; reload and try again.

## History and Undo

Recent changes are listed with what changed. You can undo a change for 30 days, as
long as it's still the latest edit to that fact.

## Forget

**Forget** deletes the fact and its change history immediately, so it can't be
undone. Fridgedoor keeps a note that the fact was forgotten (the name only, no
value) for 30 days, so a suggested update based on an old email can't quietly bring
it back. Adding the fact again yourself works as normal.

Deleting your private data in Settings removes all your facts, their history and any
pending suggestions.

## Where facts are used

Your facts are sent to your AI provider, as context, when the planner works for you:

- [Ask the planner](assistant.md): all of your facts, with each request.
- [Email suggestions](email-suggestions.md): facts relevant to the coming week, with
  each of your emails.
- [Daily brief](morning-brief.md): relevant facts, within the brief's size limit.

The model is told to treat facts as private context and not copy them into shared
suggestions unless the email itself says the same thing.

## Daily upkeep

If you've turned on the daily brief, the same setting allows a small daily upkeep
job for your facts. It archives exact duplicates and facts whose end date has
passed, and deletes archived facts after 30 days.

## For contributors

| Piece | Where |
| --- | --- |
| Storage, revisions, history, Forget | `server/src/repos/knowledge.ts` |
| Assistant proposals and review | `server/src/ai/assistant-service.ts` |
| Daily upkeep | `server/src/services/knowledge-maintenance.ts`, `server/src/ai/knowledge-maintenance.ts` |
| Routes | `server/src/routes/assistant.ts`, `server/src/routes/knowledge-maintenance.ts` |
| Web and iPhone screens | `web/src/features/Home/Household.tsx`, `ios/Fridgedoor/Features/Knowledge/` |

Notes:

- Every read and write is scoped to the owner; writes require the current revision
  and fail with `STALE_REVISION` otherwise. Adding past the limit fails with
  `KNOWLEDGE_LIMIT`.
- Facts carry provenance (user, source, maintenance, legacy), a confirmation state
  and optional `validFrom`/`validUntil` dates. The current UI and assistant don't
  set validity dates yet, which is why people are asked to write dates in the text.
- The upkeep service can also ask the main model for evidence-backed suggestions
  (add, update, archive) that the owner accepts or dismisses, with a reason and
  sources. The scheduled job currently passes it no evidence, so in practice only
  the deterministic cleanup runs. Unchanged input is never sent twice.
- Facts are not an embedding store or provider-side memory: the whole list is small
  enough to include directly in the model's context.
