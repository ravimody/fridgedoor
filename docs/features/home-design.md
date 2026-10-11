# Home and the Linen & Teal design

For contributors. Home is the screen people open every morning, so it has to stay
calm: today's schedule, the few things that need a decision, and nothing that
repeats itself. This page describes how Home is put together and the visual rules
behind it. iPhone-specific vocabulary, symbols and layout rules live in
[ios/DESIGN.md](../../ios/DESIGN.md).

## Palette and type

"Linen & Teal" pairs warm linen and ink neutrals with editorial serif headings.

| Role | Used for |
| --- | --- |
| Paper, card, ink, muted, line | Backgrounds, surfaces, text and dividers |
| Soft (gray-blue) | Routine and upcoming suggestion cards |
| Accent (slate blue) | Actions, selection, the selected day |
| Attention (teal) | Things that need a person: decisions and consequential deadlines. Nothing else. |

- Web tokens are CSS custom properties at the top of
  [`web/src/app/styles.css`](../../web/src/app/styles.css), each defined with
  `light-dark()` for both themes. The iPhone app mirrors the same values in
  [`Palette.swift`](../../ios/FridgedoorKit/Sources/FridgedoorKit/Support/Palette.swift);
  change both together.
- Headings are serif (Georgia on the web, New York on iPhone). Body text and rows
  are sans-serif.
- Never rely on color alone. Attention sections have a heading and a count, and
  dismiss actions have a text label.
- Tap targets are at least 44 points (`min-height: 44px` on the web).

## Appearance

System (the default), Light and Dark. The choice is per device, stored as
`planner-appearance` (localStorage on the web, UserDefaults on iPhone), and holds
no private data. On the web, System follows the OS through CSS `light-dark()`; the
picker is in More and in Settings. On iPhone it is in Settings. The whole app,
including dialogs and forms, uses the palette.

## Navigation

The primary navigation is **Home, To do, Groceries, More**, on both the web and
iPhone. More holds saved plans and suggestions, past requests, household knowledge
and Settings. The "Ask the planner" composer sits outside the page routes, so a
half-written message survives moving between screens. After sending, a receipt
links to the request; Home has no free-form "latest answer" panel.

Older links (`/lists`, `/household`, `/requests/:id`, `/plans/:id`) still work.

## Home structure

Home has one seven-day picker, computed in the member's time zone. Days with plans
are marked.

**Today** shows, in order:

1. The review status and any coverage notice.
2. The daily brief summary.
3. **Needs your attention**: decisions, consequential deadlines and open questions.
4. The schedule: calendar events, saved plans and to-dos due today.
5. Routine suggestions.
6. Reminders.
7. **On the horizon**: upcoming suggestions worth a look.

**Other days** show only that day's agenda and reminders. They never repeat today's
brief as though it described another day. When today has attention items, other
days show a link back to them.

To-dos without a date stay in To do; Home only places to-dos that have a due date.
A calendar row and a suggestion about the same plan are deduplicated using the
overview's `targets` (authorized `{kind, id}` pairs, no source text), so an event
isn't shown twice. A decision about an event stays separate from the event itself.

On iPhone, Home reorders by time of day: in the evening the schedule leads.

### What "attention" means

Attention is an unresolved decision or a consequential deadline. It is not the
same as an item the brief must include: required calendar commitments are always
listed, but they belong in the schedule, not in Needs your attention.

### Coverage notices

When the brief is incomplete, a notice names the affected source and says why:
the review hit its size limit, a sync is delayed, or data is unavailable. Coverage
notices are about the brief itself and are kept separate from household actions.

## Dismissing suggestions

- Swipe a suggestion card left at least 90 points to dismiss it. Vertical movement
  keeps normal scrolling. An options menu offers the same action for keyboard and
  assistive technology.
- To-dos and calendar rows can't be dismissed. To-dos need Done, a later date or
  Delete; the server rejects task dismissals too.
- Dismissing hides that exact suggestion from the brief for that person only. It
  does not complete a task, remove a calendar event, affect other members, or
  teach a preference. If the suggestion's content changes, it can appear again.
- Dismissal is optimistic: the card disappears at once and polling can't bring it
  back while the save runs. A failed save restores the card with an error.
- Undo uses a short-lived encrypted token from the server (five minutes, bound to
  the member and the dismissed item), sent to
  `POST /dashboard/api/v1/daily-overview/restore`. Expired, reused or mismatched
  tokens restore nothing. The token lives only in client memory; the dismissal
  itself is durable.

## Persistent to-dos and snoozing

Open to-dos don't age out. Once their date arrives (or immediately, if they have no
date) they stay in the daily brief until they are done, moved to a later date or
deleted.

| | Web | iPhone |
| --- | --- | --- |
| Action | Remind me later | Later |
| Choices | Tomorrow, In 3 days, In 7 days, Choose a date | Tomorrow, This weekend, Next week, Pick a date |

Moving a to-do changes its date (in the member's time zone) rather than keeping a
fake overdue deadline, and hides it from the brief until that day. Active reminders
on the to-do move to 9 AM on the new date; cancelled or completed reminders are not
revived, and no reminder is created if there wasn't one. Deadlines written in the
title or source are left alone. The endpoint is
`POST /dashboard/api/v1/list-items/:id/snooze` with `{expectedRevision, date}`.

To-do state, including a later date, is shared by the household, like completion
and edits.

## List completion and sharing

- Groceries and To do are household lists. Assigning a to-do says who is handling
  it; it doesn't make it private. Reminders, by contrast, notify only the person
  they are for.
- Checking an item moves it out of the active list immediately and restores it if
  the save fails.
- Finished items go to a collapsed **Completed** section, newest first, with when
  they were added and completed, and a **Reopen** action. Completing is not
  deleting.
- On iPhone, groceries can be grouped by store aisle and to-dos by when they're due.

## Testing

Browser tests use synthetic data mocked with Playwright's `page.route`. The specs
in [`e2e/`](../../e2e) cover morning review grouping and dismissal, Undo, appearance
and OS theme changes, day navigation, to-do snoozing and navigation. Run them with
`pnpm test:e2e`. Unit tests sit next to the components in
`web/src/features/Home` and `web/src/features/Lists`.

Real-device checks are still needed for swipe feel, scrolling and Home Screen web
app appearance on a phone.
