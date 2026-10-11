# Notifications

Fridgedoor can notify you about reminders, your morning brief, and planner activity
that needs you. There's no separate notification service: the web app uses standard
Web Push, and the iPhone app schedules notifications on the phone itself.

## Turning them on

**Web app (including an iPhone Home Screen web app).** In Settings, under phone
notifications, choose **Enable notifications** and allow the browser prompt, then
**Send test notification** to check. On iPhone, first open Fridgedoor in Safari,
choose Share → Add to Home Screen, open that icon, and enable notifications there.
Each device enrolls separately. The server creates its Web Push keys on first
start, so there's nothing to configure.

**iPhone app.** In the app's Settings → Notifications, turn on **Reminders** and
**Daily brief**. The app asks for permission the first time it needs it. These are
scheduled on the phone from your server's data each time the app refreshes, so
reminders still fire when the phone is offline. The iPhone app doesn't receive the
activity alerts below; enable the web app on the phone as well if you want them.

## What you're notified about

| Notification | When | Who |
| --- | --- | --- |
| **Reminders** | At the time you set on a plan or to-do | The person the reminder is for |
| **Morning brief** | At your chosen morning time ([morning brief](morning-brief.md)) | You, if you turned it on |
| **Review** | A request to the planner finished with calendar suggestions, list items or facts waiting for you | The person who asked |
| **Needs attention** | A request or calendar change failed, Google reported a conflict, or Google needs you to sign in again | The person affected |
| **Update** | A request finished or a calendar change went through, while you're away from the app | The person who asked |
| **Urgent email suggestion** | Something from email can't wait until the next morning brief ([details](email-suggestions.md#urgent-suggestions)) | The owner, or the whole household for a shared suggestion |
| **Unusual email processing** | Email reading volume is unusually high; at most once a day | The mailbox owner |

There are no notifications for transcription or other processing steps, and no
per-item notification settings.

### Only when you're away

Update notifications are skipped while you have Fridgedoor open on any device: the
app checks in every 15 seconds while it's visible, and you count as present for 45
seconds after that. Review and needs-attention notifications are always sent.

### Grouped, not one by one

Activity from the same 45 seconds is grouped into one notification per kind, for
example "2 calendar suggestions and 1 saved fact update are ready for review."
Tapping a notification about one item opens that request or plan; a group opens
Home.

## What's on the lock screen

Notifications use fixed titles ("Fridgedoor review", "Fridgedoor needs attention",
"Fridgedoor update", "Fridgedoor reminder") and short counts or generic phrases. They
never include an event title, email text, message, transcript or household fact.
Details open only after the app's normal sign-in checks.

In the iPhone app, a reminder on a shared plan can show its title; private reminders
show "Private reminder". With iOS's default "Show Previews: When Unlocked", the lock
screen shows only a generic placeholder.

## Delivery

- Each enrolled device gets up to three attempts, a minute and then two minutes
  apart. "Sent" means the push service accepted it, not that the phone showed it;
  occasionally a notification can arrive twice.
- Before each send, Fridgedoor checks again that you're still a member, can still see
  the item, still have the planner turned on (for requests), and that the item
  still needs you. Already-reviewed, deleted or expired items are not sent.
- Devices that the push service reports as gone are disabled.
- A failed notification never undoes the list or calendar change it was about.

Notification records hold delivery metadata only. Groups expire after a day, and
their records are deleted about a week later.

## For contributors

| Piece | Where |
| --- | --- |
| Activity discovery, batching, delivery | `server/src/services/activity-notifications.ts` |
| Reminders | `server/src/services/reminders.ts` |
| Morning notification | `server/src/services/morning-digest.ts` |
| Push provider | `server/src/providers/push.ts` |
| Service worker | `web/public/sw.js`, registered from `web/src/features/Settings/notification-worker.ts` |
| iPhone local notifications | `ios/Fridgedoor/Platform/NotificationScheduler.swift` |

Rules worth keeping:

- Activity is discovered from saved outcomes on the worker's 30-second tick, so
  nothing depends on in-memory callbacks and a restart loses nothing. Discovery only
  looks back 24 hours, which avoids replaying old activity after downtime.
- Payloads contain a fixed title, an allowlisted body, a safe app path and an opaque
  tag. The service worker re-checks the title, body format and path on receipt and
  on tap, and falls back to Home for anything unexpected.
- Bump the service worker's version query when you change its copy or checks, so
  installed workers update.
- `PUSH_PROVIDER=fake` disables delivery for tests and previews.
