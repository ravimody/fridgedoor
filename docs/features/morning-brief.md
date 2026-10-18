# Morning brief

The morning brief is a short AI-written overview at the top of Home: what's on
today, what needs a decision, and what's worth a look in the coming days. A separate
morning notification can remind you to open it at a time you choose. Each person
turns these on for themselves, either works without the other, and neither needs
Google.

Where to find the settings:

- Web app: **Settings → Notifications**. The brief is the **Morning brief** section
  ("Allow the AI morning brief for my account"). The notification is under **Morning
  notification** ("Send me a morning notification"). Both are off until you turn them on.
- iPhone app: **Settings → Morning brief** for the brief, and **Settings →
  Notifications → Morning brief** for the phone's own morning alert, which is on by
  default (see [the morning notification](#the-morning-notification)).

## The brief

### Turning it on

The brief uses the household's main AI model, so it needs an AI provider configured
on the server. Each person reads a short disclosure and turns it on for their own
account. The same switch allows the daily [household knowledge](household-facts.md)
upkeep. Turning it off discards any stored brief and cancels pending work.

When the brief is off, Home still shows a plain, non-AI list of today's calendar,
plans, to-dos and reminders.

### What it looks at

For one person at a time, the model receives:

- their time zone and today's date;
- calendar events for today and the next seven days;
- plans from the past week through the next seven days, plus undated plans, with
  short notes;
- open to-dos and active reminders;
- their own [household facts](household-facts.md);
- if email suggestions are off, recent inbox subjects and senders from Gmail.

It sees only what that person is allowed to see. Another member's private email and
plans are never included. Input is capped at 150 items, and higher-priority items are
chosen first: things that must appear, then calendar events, then everything else by
date. Suggestions you've dismissed are left out. The model has no tools and can't
change anything.

### What it shows

On Home, the brief is split into:

- **Needs your attention** (on iPhone, **Decisions**): unresolved decisions, deadlines
  the planner picks out as consequential, and questions the planner wants answered.
  Each brief can add up to two new questions, and up to five can be open at once.
- The schedule for today, with routine items for the day.
- **On the horizon**: future events and optional suggestions worth a look.

The brief aims for about eight items. Some items are required, and the model can't
drop them:

- today's calendar events;
- deadlines from the past seven days or today on plans you saved, wrote yourself or
  sent to a calendar;
- to-dos that are due today, overdue, or have no date;
- reminders due today or overdue from the past seven days.

If the required items alone exceed eight, all of them are shown. Required deadlines
appear in the schedule, not in Needs your attention. Events earlier in the day stay
listed, because the brief doesn't assume you went. Uncertain details such as "time
TBD" stay uncertain.

The brief always describes today. Picking another day in the seven-day picker shows
that day's agenda and reminders, with a link back to today's attention items.

### When it updates

- If you've also turned on the morning notification on the web, the brief is
  prepared about ten minutes before your morning time.
- Otherwise it's prepared when you open Home. Opening Home never waits on the model:
  it queues the work and shows that the brief is updating until it's done.
- It's rebuilt automatically when its inputs change (for example a new required
  event), at most once every five minutes. You can also refresh it by hand.
- Each person can start up to 12 brief generations per day, and failed attempts
  count. Home tells you when the brief is updating, out of date, failed, or has
  reached the daily limit.

If the brief can't be prepared, Home says so and keeps showing your calendar. It
never shows an old or made-up brief in its place.

A coverage notice appears when part of the input was missing, for example
"Calendar: sync delayed" or "review limit reached" (on iPhone, "brief limit
reached").

### Acting on it

- **Dismiss** a suggestion by swiping it away or from its menu. It's hidden from
  your brief only, including future mornings, and you can Undo for a few minutes.
  Dismissing doesn't complete anything, change a calendar, or affect anyone else.
  If the suggestion later changes (a new time or title), it can come back.
- To-dos can't be dismissed. Mark them done, move them to a later date, or delete
  them. Once due, a to-do stays in the brief until you do one of those.
- Questions from the planner can be answered or dismissed. Dismissing a question
  doesn't change the plan, calendar or fact it was about.

### Storage

The brief and the list of sources it used are stored encrypted for up to seven
days. Questions are kept for up to 30 days. Usage records hold only metadata
(token counts, timing) and are kept for up to 30 days. Dismissals are stored as
opaque identifiers with no copied content, and are removed when you delete your
private data.

## The morning notification

The web app and the iPhone app send separate morning notifications. Both open Home.

### On the web

This includes a web app added to an iPhone home screen. Turn on **Send me a morning
notification** and choose a time; 7:00 in your time zone is suggested. The server
sends a Web Push notification to each device where you turned notifications on, so
you need at least one enrolled device (see [notifications](notifications.md)). It's
sent whether or not the brief is on. The notification is titled "Fridgedoor morning
digest" and has no plan titles or other details.

- If the server was offline at your time, it catches up until four hours later or
  midnight, whichever comes first. A missed day is never sent the next day.
- Each device gets up to three attempts. "Delivered" means the push service
  accepted it, not that the phone displayed it.
- Daylight-saving changes keep the same local time. A time that doesn't exist on
  the spring-forward day is moved later by the gap.
- Turning the notification off stops any sends that haven't happened yet. A new
  time applies from the next day; changing the time after today's notification was
  prepared cancels today's.
- Delivery records contain no plan content and are removed about a week after the
  day they were for.

### In the iPhone app

The app schedules a "Good morning" alert on the phone itself, at the time saved in
your morning notification setting (7:00 if none is saved). It's controlled by
**Settings → Notifications → Morning** on each phone, which is on by default and
doesn't follow the web setting's on/off switch. The alert says how many things are on
today, names the first shared item and its time, and counts open decisions, for
example "3 things today. First: Soccer practice at 5:30 PM. 1 decision waiting."
With iOS previews hidden, the lock screen shows a placeholder instead.

The iPhone app also offers **Evening look-ahead**, off by default: an alert at 8:00
PM titled "Tomorrow", on evenings when tomorrow has something on it.

No email digest is sent.

## For contributors

| Piece | Where |
| --- | --- |
| Brief generation and prompt | `server/src/ai/daily-overview.ts`, `server/src/ai/relevance-guidance.ts` |
| Input assembly and budgets | `server/src/services/daily-context.ts` |
| Storage, regeneration, dismiss and restore | `server/src/services/daily-overview.ts`, `server/src/routes/daily-overview.ts` |
| Morning notification | `server/src/services/morning-digest.ts`, `server/src/jobs/scheduler.ts` |
| iPhone scheduling | `ios/Fridgedoor/Platform/NotificationScheduler.swift`, `ios/FridgedoorKit/Sources/FridgedoorKit/Support/PlatformNotificationPlan.swift` |

Rules to keep:

- Reads never call the model. Generation runs as a durable job. Manual refreshes and
  on-read recovery reuse the person's active job for the day; the scheduled job is
  enqueued separately.
- The response schema lists the allowed item references, and the service checks
  them again. Output that omits a required item is rejected.
- "Today" is anchored to the server-supplied local date. All-day end dates are
  exclusive.
- Tests: `cd server && npx vitest run src/ai/daily-overview.test.ts src/services/daily-overview.test.ts src/services/daily-context.test.ts src/services/morning-digest.test.ts`.

See [Home and the Linen & Teal design](home-design.md) for how the brief is laid out.
