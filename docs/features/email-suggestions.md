# Email suggestions

Fridgedoor reads the email you already get (school notices, team schedules,
invitations, appointment confirmations) and turns the parts worth remembering into
suggestions on Home. You decide what goes on the calendar.

It supplements your inbox; it doesn't replace reading it. Some messages will be
missed, by design: the aim is a short list of useful suggestions, not a copy of
every email.

Connecting a mailbox is covered in [connecting email](../email.md). This page is
about what happens after that.

## Turning it on

Each person connects their own mailbox (IMAP or Gmail) and then turns on email
suggestions for their own account, after reading a short disclosure. One person's
choice never turns it on for anyone else.

- When you turn it on, Fridgedoor starts with up to 100 of your most recent
  retained emails, then reads new mail as it arrives. Mail that arrived while it was
  off isn't revisited later, apart from that first batch.
- Turning it off stops future analysis, including anything queued. Suggestions
  already made stay until you deal with them.
- It needs an AI provider configured on the server. A server owner can turn it off
  for everyone with `AI_ENABLED=false`.

## From email to suggestion

1. **Fetch.** About every five minutes, Fridgedoor checks for new messages in the
   inbox. It never reads sent mail, drafts or spam, and never sends, deletes or
   marks anything as read.
2. **Skip exclusions.** Messages from senders or labels you've excluded are skipped
   before anything is sent to the AI provider.
3. **Read.** One message at a time goes to the household's email model: the subject,
   sender and text (up to about 24,000 characters) and up to five attachments (PDF,
   PNG, JPEG or HEIC; 10 MB each, 20 MB in total, PDFs up to 10 pages). With it go
   your display name, your time zone, and some of your own
   [household facts](household-knowledge.md) for context, such as which school your
   child attends.
4. **Check.** The model's answer must match a strict format and point to the exact
   text or page region it relied on. Answers that don't are rejected. The model has
   no tools and can't take any action.
5. **Sort.** Each item found becomes a shared suggestion, a private suggestion, or
   nothing (see below).

The model is told to keep things that need memory, preparation, coordination or a
decision: events, deadlines, schedule changes, real invitations, and account
changes with consequences. It leaves in email what you'd normally just read and
archive: promotions and marketing "events", routine confirmations and receipts,
forwarded device alerts, and ordinary work chatter.

### Two models (optional)

By default one model, the **email model**, reads each message. You can add a stronger
**review model** in the AI settings ([choosing a provider](../ai-providers.md)):

- The email model then only screens each message: skip, review, or not sure.
- The review model reads every message that the screen didn't confidently skip,
  every message with attachments or incomplete text, and a fixed 10% sample of the
  confident skips, to catch mistakes. It doesn't see the screen's verdict.
- If the review fails, nothing is published from that message.

## Private and shared suggestions

The source email always stays private to the person who received it. What can be
shared with the household is the suggestion: the title, time, place and a short note.

| Outcome | When | Who sees it |
| --- | --- | --- |
| **Shared** | Household logistics the model is confident about (90% or higher), with no privacy or uncertainty flags | Everyone in the household |
| **Private** | Medical items; anything uncertain; messages where an attachment or part of the text couldn't be read | Only you |
| **Nothing** | Excluded senders or labels; work email | Nobody |

You can share a private suggestion yourself: use **Share with household** in the
iPhone app, or add it to the household calendar, which shares it. In the iPhone
app's email settings you can also choose to share medical appointment times: only
the time and place are shared, as "Appointment", never the details.

## Reviewing a suggestion

Suggestions appear on Home and in the saved plans list. For each one:

- **Add to household calendar** puts it on the shared Google Calendar, if Google is
  connected and a household calendar is chosen. It needs a complete time.
- **Keep in planner** saves it in Fridgedoor without a calendar write. Kept plans
  with a date or time appear in your calendar feed.
- **Edit** fixes the title, time or place first.
- **Dismiss** hides it. On iPhone, Dismiss comes with Undo.

Nothing is written to a calendar without someone choosing to. The source email
behind a suggestion is visible only to its owner.

## Urgent suggestions

The [morning brief](morning-brief.md) is where things get resolved, so almost everything
waits for it. Interruptions are meant to be rare (a few a month for a typical household)
and same-day only: anything with a known date after your next brief waits for the brief,
however important. A few things can't wait, and send a [notification](notifications.md):

- **Deadline before the next morning brief.** A new, unresolved suggestion with a
  deadline before your next brief (your morning notification time, or 7:00). It goes
  to the owner for a private suggestion, or to every household member with
  notifications on for a shared one.
- **Needs an answer today.** When reading the email, the model can flag something that
  has to be handled before your next brief: a same-day change to a commitment, a
  closure, or a question about who covers something today. It must quote the exact sentence from the email and be
  highly confident. Emails more than a day old, or cut short, can't trigger this.
  The flag expires after an hour or at your next brief, whichever comes first, and
  only you are notified.

A deadline alone doesn't make something urgent; a marketing "offer ends tonight"
doesn't qualify. Lock-screen text is generic, for example "Household coordination
needs an answer before your next morning review." Details stay in the app.

## Exclusions

In Settings you can list **excluded senders** (full email addresses, any case) and
**excluded labels** (matched exactly as your mail provider reports them). Excluded
messages are skipped before the AI provider sees them and never become suggestions.

Email the model classifies as work is dropped too. That can't catch every work
message, so exclude work senders you know about.

## Limits

To keep costs predictable and catch runaway processing, each person's email reading
is capped at 500 analyses an hour and 3,000 a day; beyond that, work waits. Each
message gets at most three attempts. At 250 an hour or 1,000 a day, Settings shows a
warning and, if you have notifications on, you get one generic alert (at most once a
day).

Settings shows recent analyses, queued messages, failures and the last successful
analysis.

## Retention

- Email text and attachments are kept encrypted for seven days, then deleted. The
  extraction result expires with them.
- Suggestions and plans stay until you delete them; after seven days their source
  shows as unavailable.
- Deleting a message in Gmail removes its stored copy.
- Disconnecting your mailbox stops reading immediately; stored email still expires
  on the seven-day schedule.
- **Delete my private data** in Settings removes your stored email, private
  suggestions, facts and settings right away and disconnects your mailbox. Shared
  plans stay with the household.

See [what leaves your server](../privacy.md) for the provider side.

## For contributors

| Piece | Where |
| --- | --- |
| Mailbox sync and attachments | `server/src/sync/imap.ts`, `server/src/sync/gmail.ts`, `server/src/sync/attachments.ts` |
| Extraction job | `server/src/ai/extract.ts` |
| Prompt and relevance guidance | `server/src/providers/extraction.ts`, `server/src/ai/email-review-guidance.ts`, `server/src/ai/relevance-guidance.ts` |
| Two-model screening | `server/src/providers/reviewed-email.ts` |
| Evidence checks and sharing policy | `server/src/ai/policy.ts`, `server/src/domain/suggestions.ts` |
| Urgent flags | `server/src/services/plan-attention.ts`, `server/src/services/activity-notifications.ts` |
| Consent and limits | `server/src/services/background-ai.ts` |

Rules worth keeping:

- Source text is untrusted data. The extraction call has no tools.
- Sharing is decided by code (`projectPolicy`), not by the model alone: exclusions,
  work, medical, incomplete and low-confidence items are forced private or dropped.
- Consent and the mailbox connection are rechecked after the model answers and
  before anything is saved.
- Changing what counts as relevant means changing `relevance-guidance.ts` (and its
  version), which the morning brief shares.

Tests: `src/ai/evaluation.test.ts` runs synthetic privacy fixtures
(`server/test/fixtures/privacy-fixtures.json`) through the sharing policy with a fake
provider, and checks that nothing is shared unexpectedly and no times are invented.
For a live check of urgent flags, build the server and run
`node dist/ai/urgency-eval-cli.js` with `AI_PROVIDER` and `AI_API_KEY` set; it runs
eight synthetic emails through the configured provider without touching a database.
`pnpm --filter @fridgedoor/server eval:daily` runs synthetic cases through the
sharing policy three times each with a fake provider, checking that decisions are
stable and no times are invented. Keep real email out of fixtures.
