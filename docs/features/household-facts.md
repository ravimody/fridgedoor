# Household facts

Household facts is a short list of things the planner remembers about your
household, such as "Alex's school pickup is at 3:15", "we're vegetarian on weekdays"
or "swimming lessons are on Tuesdays". Each person's facts are private to them. The
planner uses them to make better suggestions, for example placing a flyer's event at
the right school when the flyer doesn't give the address.

Both apps list it under More.

## Private to you

Facts are private to the person who saved them. Other household members don't see
your facts, and the planner only uses your facts when working for you. The details
of each fact are stored encrypted on your server. Fact names are not encrypted.

## Adding and changing facts

- Add or edit a fact directly: a short name ("Dietary preference") and the
  details. You don't need AI turned on to manage facts.
- Tell the planner: "remember that soccer practice moved to Thursdays". The
  planner proposes the fact, and nothing is saved until you choose **Remember fact**
  (on iPhone, **Save to Household facts**). Saving marks the fact as confirmed by
  you.
- Search the list by name or content.
- Include dates in the text when something changes: "Starts at Maple Grove
  Middle School on Sept 2". The planner reads the dates, but Fridgedoor doesn't
  schedule the change for you.

Each person can keep up to 50 facts. A fact name can be up to 80 characters and the
details up to 500.

If the same fact was changed on another device since you opened it, your edit is
refused instead of overwriting the other change. Reload and try again.

## History and Undo

Recent changes are listed with what changed. You can undo a change for 30 days, as
long as it's still the latest edit to that fact.

## Forget

**Forget** deletes the fact and its change history immediately, and can't be undone.
Fridgedoor keeps a note that the fact was forgotten (the name only, no value) for 30
days, so a suggested update based on an old email can't bring it back without you
noticing. Adding the fact again yourself works as normal.

Deleting your private data in Settings removes all your facts, their history and any
pending suggestions.

## Where facts are used

Your facts are sent to your AI provider, as context, when the planner works for you:

- [Ask the planner](assistant.md): all of your facts, with each request.
- [Email suggestions](email-suggestions.md): your facts (up to 50, each shortened to
  300 characters), with each of your emails.
- [Morning brief](morning-brief.md): relevant facts, within the brief's size limit.

The model is told to treat facts as private context and not copy them into shared
suggestions unless the email itself says the same thing.

## Daily upkeep

If you've turned on the morning brief, the same setting allows a small daily upkeep
job for your facts. It archives exact duplicates (ignoring case and spacing) and
confirmed facts whose end date has passed. Separately, a daily cleanup job deletes
archived facts 30 days after they were archived, for everyone.

## For contributors

| Piece | Where |
| --- | --- |
| Storage, revisions, history, Forget | `server/src/repos/knowledge.ts` |
| Assistant proposals and review | `server/src/ai/assistant-service.ts` |
| Daily upkeep | `server/src/services/knowledge-maintenance.ts`, `server/src/ai/knowledge-maintenance.ts` |
| Routes | `server/src/routes/assistant.ts`, `server/src/routes/knowledge-maintenance.ts` |
| Web and iPhone screens | `web/src/features/Home/Household.tsx`, `ios/Fridgedoor/Features/Knowledge/` |

Notes:

- Every read and write is scoped to the owner. Writes require the current revision
  and fail with `STALE_REVISION` otherwise. Adding past the limit fails with
  `KNOWLEDGE_LIMIT`.
- Facts carry provenance (user, source, maintenance, legacy), a confirmation state
  and optional `validFrom`/`validUntil` dates. The current UI and assistant don't
  set validity dates yet, which is why people are asked to write dates in the text.
- Duplicate archiving also requires matching provenance, confirmation state and
  dates.
- The upkeep service can also ask the main model for evidence-backed suggestions
  (add, update, archive) that the owner accepts or dismisses, with a reason and
  sources. The scheduled job currently passes it no evidence, so in practice only
  the deterministic cleanup runs. The same input isn't sent twice on the same day.
- Facts are not an embedding store or provider-side memory. The whole list is small
  enough to include directly in the model's context.
