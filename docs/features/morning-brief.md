# Morning brief

Two separate, optional features make up the morning routine:

- **The daily brief** is a short AI-written overview at the top of Home: what's on
  today, what needs a decision, and what's worth a look in the coming days.
- **The morning notification** is a daily alert at a time you choose that opens Home.

Each person turns them on for themselves in Settings. Either works without the
other, and neither needs Google. Both are off by default.

## The daily brief

### Turning it on

The brief uses the household's main AI model, so it needs an AI provider configured
on the server. Each person reads a short disclosure and turns it on for their own
account. The same switch allows the daily [household knowledge](household-knowledge.md)
upkeep. Turning it off discards any stored brief and cancels pending work.

When the brief is off, Home still shows a plain, non-AI list of today's calendar,
plans, to-dos and reminders.

### What it looks at

For one person at a time, the model receives:

- their time zone and today's date;
- calendar events from today through the next eight days;
- plans from the past week through the next eight days, with short notes;
- open to-dos and active reminders;
- their own [household facts](household-knowledge.md);
- if email suggestions are off, recent inbox subjects and senders from Gmail.

It sees only what that person is allowed to see; another member's private email and
plans are never included. Input is capped (at most 150 items), and higher-priority
items are chosen first: things that must appear, then calendar events, then
everything else by date. Suggestions you've dismissed are left out. The model has no
tools and cannot change anything.

### What it shows

On Home, the brief is split into:

- **Needs your attention** (on iPhone, **Decisions**): unresolved decisions,
  consequential deadlines, and up to two questions the planner wants answered.
- **The schedule** for today, with routine items for the day.
- **On the horizon**: future events and optional suggestions worth a look.

The brief aims for about eight items. Some things are required and can't be
dropped by the model: today's calendar events, today's deadlines on plans you saved
or wrote yourself, to-dos due today or overdue, and reminders due today. If those
alone exceed eight, all of them are shown. Events earlier in the day stay listed;
the brief doesn't assume you went. Uncertain details such as "time TBD" stay
uncertain.

The brief always describes today. Picking another day in the seven-day picker shows
that day's agenda only.

### When it updates

- If you've also turned on the morning notification, the brief is prepared shortly
  before your morning time.
- Otherwise it's prepared when you open Home. Opening Home never waits on the
  model; it queues the work and shows "updating" until it's done.
- It's rebuilt automatically when its inputs change (for example a new required
  event), at most once every five minutes. You can also refresh it by hand.
- Each person is limited to 12 briefs per day. Home tells you when the brief is
  updating, out of date, failed, or has reached the daily limit.

If the brief can't be prepared, Home says so and keeps showing your calendar. It
never substitutes an old or made-up brief.

A coverage notice appears when part of the input was missing, for example
"Calendar: sync delayed" or "review limit reached".

### Acting on it

- **Dismiss** a suggestion by swiping it away or from its menu. It's hidden from
  your brief only, including future mornings, and you can Undo for a few minutes.
  Dismissing doesn't complete anything, change a calendar, or affect anyone else.
  If the suggestion later changes (a new time or title), it can come back.
- **To-dos** can't be dismissed. Mark them done, move them to a later date, or
  delete them. Once due, a to-do stays in the brief until you do one of those.
- **Questions** from the planner can be answered or dismissed. Dismissing a
  question doesn't change the plan, calendar or fact it was about.

### Storage

The brief and the list of sources it used are stored encrypted for up to seven
days. Questions are kept for up to 30 days. Usage records hold only metadata
(token counts, timing) and are kept for up to 30 days. Dismissals are stored as
opaque identifiers with no copied content, and are removed when you delete your
private data.

## The morning notification

Turn it on in Settings and choose a time; 7:00 in your time zone is suggested. It
opens Home. The notification itself is generic, with no plan titles or other
details on the lock screen. It's sent whether or not the daily brief is on.

**On the web** (including a web app added to an iPhone Home Screen), the server
sends it as a Web Push notification to each device where you turned notifications
on. You need at least one enrolled device; see [notifications](notifications.md).

- If the server was offline at your time, it catches up until four hours later or
  midnight, whichever comes first. A missed day is never sent the next day.
- Each device gets up to three attempts. "Delivered" means the push service
  accepted it, not that the phone displayed it.
- Daylight-saving changes keep the same local time. A time that doesn't exist on
  the spring-forward day is moved later by the gap.
- Changing or turning off the schedule after today's notification was prepared
  takes effect tomorrow.
- Delivery records contain no plan content and are removed about a week after the
  day they were for.

**In the iPhone app**, the app schedules the notification on the phone itself at
your saved time, using the same setting. You can turn it off per device in the
app's notification settings.

No email digest is sent.

## For contributors

| Piece | Where |
| --- | --- |
| Brief generation and prompt | `server/src/ai/daily-overview.ts`, `server/src/ai/relevance-guidance.ts` |
| Input assembly and budgets | `server/src/services/daily-context.ts` |
| Storage, regeneration, dismiss and restore | `server/src/services/daily-overview.ts`, `server/src/routes/daily-overview.ts` |
| Morning notification | `server/src/services/morning-digest.ts`, `server/src/jobs/scheduler.ts` |
| iPhone scheduling | `ios/Fridgedoor/Platform/NotificationScheduler.swift` |

Rules worth keeping:

- Reads never call the model. Generation runs as a durable job, and manual and
  automatic refreshes share one active job per person and day.
- The response schema lists the allowed item references, and the service checks
  them again; output that omits a required item is rejected.
- "Today" is anchored to the server-supplied local date. All-day end dates are
  exclusive.
- Tests: `cd server && npx vitest run src/ai/daily-overview.test.ts src/services/daily-overview.test.ts src/services/daily-context.test.ts src/services/morning-digest.test.ts`.

See [Home and the Linen & Teal design](home-design.md) for how the brief is laid out.
