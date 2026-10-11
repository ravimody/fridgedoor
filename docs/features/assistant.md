# Ask the planner

"Ask the planner" is the household assistant. You tell it something in your own
words, or hand it a flyer or a link, and it turns that into list items, calendar
suggestions or remembered facts, or simply answers a question about your plans.

It's separate from [email suggestions](email-suggestions.md): it only sees what you
send it plus the household context it looks up, never your mailbox.

## What you can send

- **Text**, up to 8,000 characters: "dinner with the Parkers Friday 7pm", "add oat
  milk and eggs", "what's left for the bake sale?".
- **Voice**: tap the mic, speak, and it stops by itself when you pause.
- **One photo or PDF per request**: a flyer, a screenshot of a schedule, a party
  invitation. JPEG, PNG, HEIC or PDF, up to 10 MB; PDFs up to 10 pages.
- **Links**. With providers that support web search (OpenAI and Anthropic), the
  planner can look up a recipe or a business. A Google Docs, Sheets or Slides link
  shared as "anyone with the link" is read directly; see [tools](#tools).

The composer is available from every screen in the web app and the iPhone app. A
half-written message is kept as you move around. On iPhone you can also use the
share sheet, or say "Ask Fridgedoor" to Siri. Shortcuts and the share sheet use a
capture token that can only submit items, not read anything; those items wait up to
seven days if the planner is off or busy.

## Turning it on

The planner is available whenever the server has an AI provider configured. A
server owner can turn it off for everyone with `ASSISTANT_ENABLED=false`.

Each person turns it on for their own account after reading a short disclosure of
what is sent to the AI provider. This doesn't turn on email suggestions. You can
turn it off again from the household knowledge page; any requests still waiting are
cancelled.

## What happens when you send

Your request is stored encrypted and queued before the app confirms it, so you can
close the app straight away. A receipt links to the request, where you can watch it
finish and review the result. A request that fails keeps your input and offers
**Retry**; it never runs twice by accident.

Each person can have up to ten requests waiting at once. Each run is limited to two
minutes and four tool calls.

### Applied directly, with Undo

Plain list commands are added straight away: "add milk to groceries", "put call the
plumber on the to-do list". The receipt shows **Added** with an **Undo** button.
This only happens when all of these are true:

- you typed or spoke the request (no photo, PDF, shared item or Shortcut);
- the planner didn't look anything up on the web or read a shared document;
- the item is a grocery or to-do that you explicitly asked to add.

Undo works for seven days, as long as nobody has edited or completed the item since.

### Proposed for review

Everything else waits for you:

- **Events.** Choose **Add to household calendar** (needs Google Calendar connected
  and a household calendar chosen in Settings), **Keep in planner**, **Edit** or
  **Dismiss**. On iPhone these read **Add to calendar** and **Save**, with Edit
  and Dismiss under the ••• menu.
  - A kept event stays in Fridgedoor and appears in your calendar feed if it has a
    time or date. It stays private to you until it's shared; adding it to the
    household calendar shares it.
  - An event needs a complete time before it can go on a calendar. If you gave only
    a start time, the planner picks a typical length and says so under
    **Assumptions**; if it doesn't, Fridgedoor assumes one hour and says that
    instead.
- **Groceries and to-dos** found in a flyer, link or recipe: **Add to groceries** or
  **Add to todos**.
- **Facts to remember** ("we're vegetarian on weekdays"): **Save** or **Dismiss**.
  See [household knowledge](household-knowledge.md).

You review each item on its own: adding the event to the calendar doesn't also
approve the groceries. Deleting a request later keeps anything you already saved.

Each request shows its outcome, for example "Added to household lists", "Saved in
planner", "Waiting for Google Calendar", "Added to Google Calendar", "Needs review"
or "Reply ready". These labels come from what was actually saved, not from the
planner's wording.

### Dates

The planner receives the moment you sent the request in your time zone, so "next
Friday" is read relative to when you asked, even if the request was processed later.
It's still a model's reading, which is why events wait for review.

## Tools

The planner can use these tools while answering. None of them receives passwords,
sign-in tokens, or the ability to write to a calendar or mailbox.

| Tool | What it does |
| --- | --- |
| `household_context` | Reads today's agenda, up to 30 plans you can see, and the active grocery and to-do lists. No mailbox contents. |
| `public_lookup` | A separate web-search request that contains only a short public query (for example a business name and town). Offered only when the provider supports web search: OpenAI and Anthropic. |
| `read_shared_document` | Fetches the plain-text export of a public Google Docs, Sheets or Slides link (Sheets: the linked tab as CSV), up to 40,000 characters, without any Google sign-in. Private documents fail with a message asking you to share the link. Text inside images isn't included. |

Web lookups are best-effort research, not a browser or a map: blocked pages and
ambiguous results (two branches of the same store, say) are reported as uncertain.

## Voice

**Web app.** The browser records locally and stops after about 1.5 seconds of quiet
following speech; if it hears nothing usable in ten seconds it cancels without
uploading. Recordings are capped at two minutes. The audio is sent to the server
and transcribed by your AI provider, which needs a provider with transcription
(OpenAI or Groq). It's held in memory for that request only and never stored.
Each person can transcribe up to 30 clips an hour. If transcription fails, the clip
stays for **Retry voice**, or use your keyboard's dictation. Browsers that can't
record locally fall back to the browser's own speech recognition, which may use
the browser vendor's speech service.

**iPhone app.** Speech is transcribed on the phone. Only if no on-device speech
model is available does the app upload the recording for server transcription. A
phone call or Siri interrupting you puts the words in the draft for review instead
of sending them.

## Privacy

Sent to your AI provider for each request:

- what you sent: the text, transcript, photo or PDF;
- your saved [household facts](household-knowledge.md) and your last few requests,
  for context;
- whatever the tools return: your agenda, plans and lists, a shared document's text,
  or web search results.

It never includes other members' private plans or email. Content from photos, links
and documents is treated as untrusted data, and the model's output is validated
before anything is saved. Each provider has its own retention policy for API data;
see [what leaves your server](../privacy.md).

On the server:

- Requests and results are kept for seven days, then deleted. Uploaded photos and
  PDFs are wiped after seven days. Anything you saved (plans, list items, facts)
  stays until you delete it.
- **Delete request** removes a request early and cancels it if it's still running.
- Turning the planner off cancels waiting requests. Deleting your private data in
  Settings removes your requests, facts and private plans.
- Logs and diagnostics hold only metadata: model, token counts, duration, tool names
  and an error code. Request details show a run ID; quote it, together with a
  **Helpful** or **Needs work** rating, when reporting a problem, so whoever runs the
  server can investigate without reading private content.

## For contributors

| Piece | Where |
| --- | --- |
| Agent loop, prompt and tools | `server/src/ai/agent.ts`, `server/src/ai/shared-document.ts` |
| Durable lifecycle, review, Undo | `server/src/ai/assistant-service.ts` |
| HTTP routes | `server/src/routes/assistant.ts` (web), `server/src/routes/native.ts` (iPhone), `server/src/routes/shortcut-capture.ts` (capture tokens) |
| Provider calls, web search, transcription | `server/src/llm/`, `server/src/providers/transcription.ts` |
| Outcome labels | `packages/contracts/src/outcomes.ts` |

Rules worth keeping:

- The model never chooses the acting member, credentials or sharing; those come from
  the authenticated request.
- Consent and the job lease are rechecked whenever household context is read, and
  consent, membership and the lease again before saving.
- Calendar and knowledge changes always need review. Only explicit list commands in
  plain text may be applied directly.
- Check provider `capabilities` before offering web search or sending images and
  PDFs; models without vision get a note that an attachment was skipped.

Tests: `cd server && npx vitest run src/ai/agent.test.ts src/ai/assistant-service.test.ts`.
Normal tests use a fake provider. For a live check with synthetic inputs, build the
server and run `node dist/ai/agent-eval.js <model>` with `AI_PROVIDER` and
`AI_API_KEY` set. It runs a few synthetic tasks (an event, groceries, a context
question, a fact, a poster) through the real agent without touching a database. An
optional second argument is a JSON file of extra cases; keep real household content
out of git.
