# Fridgedoor iOS: design rules

The rules every screen follows. They came out of the October 2026 UX review; keep
new work consistent with them, and change this file in the same PR when a rule
changes. Palette and type tokens live in `FridgedoorKit/.../Palette.swift`; shared
views in `Fridgedoor/DesignSystem/`. Fridgedoor is used by many households, each on
its own server: never assume one family, one domain or one setup in copy.

## Words

One word per concept, everywhere: app, widgets, notifications, Siri phrases.

| Concept | Use | Never |
|---|---|---|
| AI summary of the day | **Daily brief** ("Brief" on Home; notification "Your brief is ready") | Morning review, morning digest, daily planner AI |
| Item found in email, undecided | **Suggestion** (Home section: **Decisions**) | Plan to review, proposed |
| Keep without the calendar | **Save** → status **Saved** | Keep in planner, saved in planner |
| Put on the shared Google calendar | **Add to calendar**; **Apply update** → **On household calendar** | Add to household calendar |
| Export to this iPhone's calendar | **Add to Apple Calendar** (always in •••) | Add to Calendar… |
| Hide a suggestion | **Dismiss** (always with Undo) | Hide, Remove |
| Delete something you own | **Delete** | Remove |
| Push a to-do to another day | **Later** (moon icon) → "Back Sat" | Remind me later, snooze |
| A personal alert | **Remind me** (bell) | |
| Something asked of the assistant | **Request** / **Requests** | Conversation |
| Facts the assistant remembers | **Household facts** | Household knowledge, memory |
| A to-do item | **to-do** (tab: **To do**) | task, todo |
| Rating suggestions | **Teach suggestions** | Suggestion feedback, relevance trial |
| The assistant | **the planner** ("Ask the planner"; Siri: "Ask Planner"); **Fridgedoor** is the app | assistant, planning assistant |
| Where the household's data lives | **server** ("your household's own server"); show its host, e.g. `fridgedoor.example.com` | instance, backend, cloud, account |
| The QR code / link from the web app | **pairing code**; scanning it is **Scan pairing code**; the web page is **Settings → iPhone** | QR login, magic link, invite |
| Leaving one server for another | **Switch server** | Change server, reset |

Copy rules:
- Sentence case. Relative days are lower case mid-sentence: `TimeLabels.relativeDayInSentence`.
- Past tense once something has happened ("Added 3 items"), never a promise next to a done chip.
- Errors say what to do next, never internals ("couldn't read that link — paste the text instead").
- Don't caption a control to explain its label. Fix the label, or show the state.
  Explanations belong in empty states and one-time hints, not on every visit.
- Mark the exception, not the rule: shared is the default; private things get "Only you" with a lock.

## Decisions

- Every plan decision uses `PlanDecisionBar` and `PlanStatusLine` (`Features/Plans/PlanDecision.swift`).
  Order never changes: the outcome verb, then Save, then •••.
- Never show a disabled primary action. When something is missing, the primary action
  is the missing step (`Set time` opens `SetTimeSheet`).
- Dismiss lives in ••• or a swipe, uses `store.dismissWithUndo`, and is never a large red button.
  Destructive calendar changes ("Remove from calendar") live in ••• with a confirmation.

## Surfaces and color

- Grouped lists: `.plannerList()` on the `List`, `.plannerRows()` on each `Section`
  (paper background, card rows) — including Settings, More, Household facts and editors.
- Teal (`attention`) means "needs you" and nothing else: not success, not settings tiles.
  Accent is for actions and selection (including the Now line); amber (`warning`) for time
  (overdue, later, tentative); red (`danger`) only for destructive actions and failures.
- Liquid Glass is for navigation: toolbars, the bottom accessory, floating controls. Not on content.
- People: `PersonAvatar` (initial in the person's color from `PersonColor`). Names come from
  `store.household`.

## Type

- Serif (`Font.serif`) for page titles and section headings only. Rows are sans: `.body`
  (semibold for objects such as plans and requests), meta in `.subheadline` muted.
- Section headings: `SectionHeading`.

## Sheets, swipes, menus

- Sheets: "Cancel" (text) leading; the confirm verb ("Save", "Add", "Send") trailing as
  `.confirmationAction`. Ask "Discard changes?" when cancelling with edits.
  `.medium` detent for one-question sheets, `.large` for editors.
- Swipes mirror the first context-menu items. Lists: leading Done; trailing Later, Assign/Move,
  Delete. Suggestions: leading Save; trailing Dismiss. Tints follow the action: accent for Done,
  amber for Later/Snooze, red only for Delete, neutral for Dismiss.
- One symbol per concept: `moon.zzz` Later, `bell` Remind me, `eye.slash` Dismiss (`xmark` only
  closes), `basket` Groceries, `sparkles` Ask the planner, `mappin.and.ellipse` places,
  `calendar.badge.plus` Add to calendar, `square.and.arrow.up.on.square` Apple Calendar export.

## Apple Watch

- Glanceable and finite: Today (brief, a Decisions row, what's left today) and Decisions.
  No lists, settings or editing; anything more says "Decide on your iPhone".
- Decisions are Home's (`WatchPayload`): the same rows and words (Save, Add to calendar,
  Dismiss with `eye.slash` in a swipe), minus any already decided. Teal marks the
  Decisions row only.
- Show what happened at once; if the iPhone can't do it, put the row back and say why.

## Accessibility

- Every tappable target is at least 44×44pt (`contentShape` + frame).
- Icon-only buttons are labeled with their action ("Plan actions", not "More").
- Toasts announce themselves; Undo stays up 30s while VoiceOver runs (`Toast.undoWindow`).
- Layouts adapt at accessibility sizes (`dynamicTypeSize.isAccessibilitySize`) instead of
  squeezing fixed columns.

## Welcome and servers

- There is no default server. Signed out, the welcome screen offers Scan pairing code
  (primary), Enter server address, and "Don't have a server? Set one up".
- Name the host before anything is sent to a server: a pairing link always goes through
  "Connect to <host>?" (`PairingConfirmSheet`), wherever it came from.
- Plain http gets an amber (`warning`) notice: fine on a home network or Tailscale.
  http to a public host is refused, never just warned about.
- Server checks fail with what to do next ("isn't set up yet — open it in a browser"),
  not with HTTP or TLS internals.

## Settings

- Grouped by intent (Household, Your day, Suggestions, then the rest). Row values summarize
  state ("Connected", "7:00 AM") so most people never open the page. Icons are tinted
  glyphs (`SettingsRowLabel`), never colored tiles.
- Switches save immediately (Calendars, which saves a set of choices, uses a toolbar Save
  and also saves on leaving). Consent text sits beside the control that accepts it;
  turning on email suggestions asks in a sheet ("Agree and turn on"). Destructive actions (Disconnect, Delete my data, Turn off) sit at the bottom of their
  page, each in its own section.
- Policy and consent text: up to three short bullets plus "Read more" (`SettingsSummary`),
  keeping the full text one tap away. Operator details (server, AI provider, limits, sync
  counts, raw ids) live in Help & diagnostics only.
- Pushed Settings pages need `.environment(model)` on every `NavigationLink` destination.
