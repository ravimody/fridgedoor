# What leaves your server

Fridgedoor keeps your household's data in one SQLite database on the server you run.
There is no Fridgedoor company service, analytics or telemetry. Data leaves the server
only in the cases below.

## Your AI provider

The provider you choose in Settings → AI receives, one request at a time:

- **Email you connected**, after you turn on email suggestions: one message at a time,
  trimmed to about 24,000 characters, plus up to five image or PDF attachments. Along
  with it go that person's display name and time zone and a few of their own saved
  facts (for example "school pickup is at 3:15") to judge relevance. Other members'
  names and facts are not included.
- **What you send the planner**: the text, photo, PDF or link you submit, recent
  conversation, and the household plans and lists the planner looks up to answer.
- **Daily brief and knowledge upkeep**, if you turn them on: a summary of your upcoming
  plans and lists, and, when email suggestions are off, the subjects and senders of your
  recent emails so the brief can mention what's waiting.

It does not receive passwords, sign-in tokens, other members' private plans, or your
whole mailbox. Content from emails and web pages is treated as untrusted; the model
can't take actions on its own, and every result is validated before it's saved.

Each provider has its own retention policy for API data (commonly up to 30 days for
abuse monitoring, not used for training by default). Check your provider's API data
policy, or use a local model through Ollama or LM Studio to keep everything at home.

## Other services, only if you use them

- **Your email provider** (IMAP or Gmail): Fridgedoor reads your inbox.
- **Google Calendar**, if you connect Google: reads selected calendars and adds events
  you approve to the household calendar.
- **Web Push** (Apple, Google or Mozilla's push services): notification titles and
  short text for reminders on devices where you turned notifications on.
- **Web lookups** by the assistant (OpenAI and Anthropic only): short public search
  terms, such as a business name and town, sent through the AI provider's search tool.
- **Shared Google Docs, Sheets or Slides links** you give the assistant: fetched
  directly from Google.

## On the server

- Email content, plans, lists, AI keys and email passwords are encrypted in the
  database with a key stored next to it (`secret.key` in the data directory). Anyone
  with both the database and that file can read the data, so protect backups.
- Each person's email is visible only to them. Clear everyday logistics found in it
  become shared plans automatically; uncertain, personal, medical or work items stay
  private until that person shares them. Household members see shared plans, shared
  lists and each other's names.
- The server operator (whoever has shell access to the machine) can technically read
  everything. That's usually you.
- Email evidence is kept for seven days and then deleted; plans and lists stay until
  you delete them. Settings → Email → **Delete my private
  data** removes a person's email-derived and other private data; plans they shared stay.
- Logs contain error codes and counts, never email content, prompts or answers.
