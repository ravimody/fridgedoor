# Architecture

```mermaid
flowchart LR
  Web[Web app / PWA] -->|session cookie + CSRF| API[Hono API]
  iOS[iPhone app, widgets, Siri, share sheet] -->|bearer tokens /native/v1| API
  Watch[Apple Watch app] -->|WatchConnectivity, no credential| iOS
  Cal[Any calendar app] -->|webcal token| API
  API --> DB[(SQLite, encrypted fields)]
  Worker[Background worker] --> DB
  Worker -->|IMAP or Gmail API| Mail[Email]
  Worker -->|Google Calendar API| GCal[Google Calendar]
  Worker -->|one adapter per wire format| LLM[AI provider]
  API -->|connection tests, voice transcription| LLM
  Worker --> Push[Web Push]
```

## Pieces

| Path | What it is |
| --- | --- |
| `server/` | Hono on Node 22: API, web app hosting and the background worker (one process by default) |
| `web/` | React 19 + Vite web app served at `/dashboard/`, installable as a PWA |
| `packages/contracts/` | Zod schemas shared by server and web: the public API shapes |
| `ios/` | SwiftUI app with widgets, a share extension and an Apple Watch app (MPL-2.0) |
| `deploy/` | Container entrypoint, installer, Caddy/Tailscale configs, cloud-init |

## Server layout

| `server/src/...` | Responsibility |
| --- | --- |
| `index.ts`, `config.ts`, `runtime.ts`, `cli.ts` | Start-up, configuration, first-run defaults, admin commands |
| `app.ts`, `routes/` | HTTP boundary: authentication, validation, response shapes |
| `auth/` | Built-in accounts, sessions, CSRF, native tokens, optional Cloudflare Access |
| `settings.ts` | Encrypted settings edited in the web app; environment overrides |
| `llm/` | Provider-neutral model interface and adapters (OpenAI Responses, Anthropic Messages, OpenAI-compatible) |
| `ai/` | Prompts and model-facing features: extraction, the planner agent, daily overview, knowledge upkeep |
| `sync/` | Email (IMAP, Gmail) and Google Calendar ingestion |
| `services/`, `repos/`, `domain/` | Household features and database access |
| `jobs/` | Durable job queue, scheduler and worker loop |
| `db/migrations/` | Ordered SQL migrations, applied at start |

## Rules that keep it safe

- Every member belongs to one household, and every query is scoped by member and
  household. The schema allows several households, but setup creates one per server. A
  plan is private to its owner until shared.
- Actors come from authentication only. Routes derive the member from the session or
  token. The model never chooses who acts, which credentials to use, or what to share.
- Model output is untrusted. Every response is parsed against a strict schema and checked
  against source evidence and privacy rules. Email extraction can only produce
  suggestions, and writes to Google Calendar happen only after a person approves.
- Errors are stable codes. Provider and mailbox errors are reduced to codes such as
  `AI_RATE_LIMITED` or `IMAP_AUTH_FAILED`, and provider text never reaches logs or clients.
- Work is durable. Email polling, extraction, reminders and briefs run as leased jobs in
  SQLite with retries. Results from a stale lease, a disconnected mailbox or a removed
  member are discarded.
- Sensitive data is encrypted at rest. Email evidence, private plan versions,
  conversations, saved facts, calendar event data, tokens, passwords and keys are
  AES-256-GCM envelopes keyed from the server secret. Shared plan facts and list items
  are stored unencrypted.

## Email and calendar

Email connections (Gmail via OAuth, or IMAP via an app password) share one table and one
pipeline: poll → normalize to evidence → extraction job → suggestions. Both are polled
every 5 minutes. IMAP keeps a `UIDVALIDITY:UID` cursor and opens the mailbox read-only.
The calendar feed publishes saved plans as iCalendar. Google Calendar, when connected, is
read for the agenda and written only for approved shared plans.

## AI

`LlmHub` resolves the configured provider and model per call, so changing AI settings in
the web app applies without a restart. The roles are:

- `main`: the planner, morning brief, household facts and relevance learning
- `email`: reading email (defaults to `main`)
- `review`: optional. When it's set, the `email` model only screens each message and
  `review` extracts plans from the ones it flags.
- `transcribe`: voice transcription

Adapters report capabilities (images, PDFs, tools, web search, transcription), and
features keep working with less when one is missing.

## Features

Behavior and code pointers for each feature:

- [Ask the planner](features/assistant.md)
- [Email suggestions](features/email-suggestions.md)
- [Morning brief](features/morning-brief.md)
- [Household facts](features/household-facts.md)
- [Notifications](features/notifications.md)
- [Home and the Linen & Teal design](features/home-design.md)
