# Ask the planner

The planner is Fridgedoor's household assistant. Tell it something in your own
words, or hand it a flyer or a link. It turns that into list items, calendar
suggestions or remembered facts, or answers a question about your plans. Calendar
events and facts always wait for your review; only plain list commands are added
straight away.

The planner is separate from [email suggestions](email-suggestions.md). It sees only
what you send it plus the household context it looks up, never your mailbox.

## What you can send

- Text, up to 8,000 characters: "dinner with the Parkers Friday 7pm", "add oat
  milk and eggs", "what's left for the bake sale?".
- Voice: tap the mic, speak, and it stops by itself when you pause.
- One photo or PDF per request: a flyer, a screenshot of a schedule, a party
  invitation. JPEG, PNG, HEIC or PDF, up to 10 MB. PDFs can have up to 10 pages.
- Links. With providers that support web search (OpenAI, Azure OpenAI and
  Anthropic), the planner can look up a recipe or a business. A Google Docs, Sheets
  or Slides link shared as "anyone with the link" is read directly; see
  [tools](#tools).

The composer is available from every screen in the web app and the iPhone app, and a
half-written message is kept as you move around. On iPhone you can also use the
share sheet, or say "Ask Planner" to Siri.

The share sheet and Shortcuts you build with a capture token (Settings → Send from
other apps) can only submit items and check their status. They can't read your
plans. Their items wait up to seven days if the planner is off or busy. A Siri
request uses the app's own sign-in instead, and is refused straight away if the
planner is off.

## Turning it on

The planner is available whenever the server has an AI provider configured. A
server owner can turn it off for everyone with `ASSISTANT_ENABLED=false`.

Each person turns it on for their own account after reading a short disclosure of
what is sent to the AI provider. This doesn't turn on email suggestions. You can
turn it off again from the household knowledge page, which cancels any requests
still waiting.

## What happens when you send

Your request is stored encrypted and queued before the app confirms it, so you can
close the app straight away. A receipt links to the request, where you can watch it
finish and review the result. A request that fails keeps your input and offers
**Retry**. Nothing from a request is saved twice.

Each person can have up to ten requests waiting at once. Each run is limited to two
minutes and four tool calls. A run that needs more tool calls fails and can be
retried.

### Added straight away, with Undo

Plain list commands are added straight away: "add milk to groceries", "put call the
plumber on the to-do list". The receipt shows **Added** with an **Undo** button.
This only happens when all of these are true:

- you typed or spoke the request in the composer or to Siri (no photo, PDF, share
  sheet item or capture-token Shortcut);
- the planner didn't look anything up on the web or read a shared document;
- the item is a grocery or to-do that you explicitly asked to add.

Undo works for seven days, as long as nobody has edited or completed the item since.

### Waiting for your review

Everything else waits for you:

- Events. Choose **Add to calendar** (needs Google Calendar connected
  and a household calendar chosen in Settings), **Save**, **Edit** or **Dismiss**. On
  iPhone, Edit and Dismiss are under the ••• menu.
  - A kept event stays in Fridgedoor and appears in your calendar feed if it has a
    time or date. It stays private to you until it's shared. Adding it to the
    household calendar shares it.
  - An event needs a complete time before it can go on a calendar. If you gave only
    a start time, the planner picks a typical length and says so under
    **Assumptions**. If it doesn't, Fridgedoor assumes one hour and says that
    instead.
- Groceries and to-dos found in a flyer, link or recipe: **Add to groceries** or
  **Add to todos** (on iPhone, **Add to Groceries** or **Add to To do**).
- Facts to remember ("we're vegetarian on weekdays"): **Remember fact** or
  **Dismiss** on the web, **Save to Household facts** on iPhone. A request to forget
  a fact shows **Forget fact** (on iPhone, **Forget**). See
  [household knowledge](household-facts.md).

You review each item on its own: adding the event to the calendar doesn't also
approve the groceries. Deleting a request later keeps anything you already saved.

Each request shows its outcome, for example "Added to household lists", "Saved in
planner", "Waiting for Google Calendar", "Added to Google Calendar", "Needs review"
or "Reply ready". These labels come from what was saved, not from the planner's
wording.

### Dates

The planner receives the moment you sent the request in your time zone, so "next
Friday" is read relative to when you asked, even if the request was processed later.
It's still a model's reading, which is why events wait for review.

## Tools

The planner can use these tools while answering. None of them receives passwords,
sign-in tokens, or the ability to write to a calendar or mailbox.

| Tool | What it does |
| --- | --- |
| `household_context` | Reads your calendar for today and the next seven days, up to 30 plans you can see, and the active grocery and to-do lists. No mailbox contents. |
| `public_lookup` | A separate web-search request that contains only a short public query (for example a business name and town) and the date and time zone it's asked from. Offered only when the provider supports web search. |
| `read_shared_document` | Fetches the plain-text export of a public Google Docs, Sheets or Slides link (for Sheets, the linked tab as CSV), up to 40,000 characters, without any Google sign-in. Private documents fail with a message asking you to share the link. Text inside images isn't included. |

Web lookups are best-effort research, not a browser or a map. Blocked pages and
ambiguous results (two branches of the same store, say) are reported as uncertain.

## Voice

In the web app, the browser records locally and stops after about 1.5 seconds of
quiet following speech. If it hears nothing usable in ten seconds, it cancels without
uploading. Recordings are capped at two minutes. The audio is sent to the server and
transcribed by your AI provider, which must support transcription (OpenAI, Azure
OpenAI with `AI_MODEL_TRANSCRIBE` set, or Groq). The audio is held in memory for that
request only and never stored. Each person can transcribe up to 30 clips an hour. If
transcription fails, the clip stays for **Retry voice**, or you can use your
keyboard's dictation. Browsers that can't record locally fall back to the browser's
own speech recognition, which may use the browser vendor's speech service.

In the iPhone app, speech is transcribed on the phone when it can be. The app uploads
the recording for server transcription only when on-device recognition isn't
available. If a phone call or Siri interrupts you, the words go into the draft for
review instead of being sent.

## Privacy

Sent to your AI provider for each request:

- what you sent: the text, transcript, photo or PDF;
- your saved [household facts](household-facts.md) and your last three requests,
  for context;
- whatever the tools return: your calendar, plans and lists, a shared document's
  text, or web search results.

It never includes other members' private plans or email. Content from photos, links
and documents is treated as untrusted data, and the model's output is validated
before anything is saved. Each provider has its own retention policy for API data;
see [what leaves your server](../privacy.md).

On the server:

- Requests and results are kept for seven days, then deleted. Uploaded photos and
  PDFs are wiped after seven days. Anything you saved (plans, list items, facts)
  stays until you delete it.
- **Delete request** removes a request early and cancels it if it's still running.
- Turning the planner off cancels waiting requests. **Delete my private data** in
  Settings removes your requests, facts and private plans.
- Server logs hold only the job, its duration and an error code. Each request also
  stores its model, token counts, duration and tool names, which request details
  show along with a run ID. When reporting a problem, quote the run ID together with
  a **Helpful** or **Needs work** rating, so whoever runs the server can investigate
  without reading private content.

## For contributors

| Piece | Where |
| --- | --- |
| Agent loop, prompt and tools | `server/src/ai/agent.ts`, `server/src/ai/shared-document.ts` |
| Durable lifecycle, review, Undo | `server/src/ai/assistant-service.ts` |
| HTTP routes | `server/src/routes/assistant.ts` (web and iPhone; `server/src/routes/native.ts` forwards iPhone calls to it), `server/src/routes/captures.ts` and `server/src/services/captures.ts` (uploads), `server/src/routes/shortcut-capture.ts` (capture tokens) |
| Provider calls, web search, transcription | `server/src/llm/`, `server/src/providers/transcription.ts` |
| Outcome labels | `packages/contracts/src/outcomes.ts` |

Rules to keep:

- The model never chooses the acting member, credentials or sharing. Those come
  from the authenticated request.
- Consent and the job lease are rechecked whenever household context is read, and
  consent, membership and the lease again before saving.
- Calendar and knowledge changes always need review. Only explicit list commands in
  plain text may be applied directly.
- Check provider `capabilities` before offering web search or sending images and
  PDFs. Models without vision get a note that an attachment was skipped.

Tests: `cd server && npx vitest run src/ai/agent.test.ts src/ai/assistant-service.test.ts`.
Normal tests use a fake provider. For a live check with synthetic inputs, build
`packages/contracts` and the server, then run `node dist/ai/agent-eval.js <model>`
from `server/` with `AI_PROVIDER` set (and `AI_API_KEY` for a hosted provider). It
runs five synthetic tasks (an event, groceries, a context question, a fact, a poster)
through the agent without touching a database. An optional second argument is a JSON
file of extra cases. Keep real household content out of git.
