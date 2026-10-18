# What leaves your server

Fridgedoor keeps your household's data in one SQLite database on the server you run.
There is no Fridgedoor company service, analytics or telemetry. Data leaves the server
only in the cases below.

## Your AI provider

The provider you choose in Settings → AI receives the following, one request at a time.
Each item is sent only after that member turns the feature on for their own account.

- Email you connected, once you turn on email suggestions (Settings → Email → Email
  suggestions). Turning it on starts with up to 100 recent stored emails, then each new
  one. Every message in the inbox is sent, one at a time, except those from excluded
  senders and labels. Each message is trimmed to 24,000 characters and goes with its
  subject, sender and up to five image or PDF attachments. If a review model is set, the
  first model gets only the text, and the review model gets the attachments for the
  messages it reads. Along with each message go that person's display name and time
  zone and up to 50 of their own saved facts (for example "school pickup is at 3:15").
  If they rated suggestions, the preferences learned from those ratings go too. Other members' names and facts are
  not included.
- What you send the planner: your message, the photo, PDF or link you attach, your last
  three exchanges with it, and all of your saved facts. When the planner needs more, it
  looks things up. It can see your agenda (the household calendar and your own
  calendars), up to 30 plans (shared ones and your own), and the open grocery and to-do
  items.
- The morning brief, if you turn on Settings → Notifications → Morning brief.
  It gets your upcoming calendar events, plans and their preparation tasks, open to-dos,
  reminders, saved facts and learned preferences. When email suggestions are off, it
  also gets the subject (or the sender, if there's no subject) of your recent inbox
  emails, so the brief can mention what's waiting.
- Nightly learning, if you turn on both Learn what matters to me (on the What belongs on
  your Home? page) and the daily planner overview. It gets the titles and notes of
  suggestions you rated, your ratings and reasons, and the sender and an excerpt of each
  source email.

It does not receive passwords, sign-in tokens or other members' private plans. Mail in
other folders, spam, trash and drafts is never sent. Content from emails and web pages
is treated as untrusted: the model can't take actions on its own, and every result is
validated before it's saved.

Each provider has its own retention policy for API data (commonly up to 30 days for
abuse monitoring, and not used for training by default). Check your provider's API data
policy, or use a local model through Ollama or LM Studio to keep everything at home.

## Other services, only if you use them

- Your email provider (IMAP or Gmail): Fridgedoor reads your inbox.
- Google Calendar, if you connect Google: Fridgedoor reads the calendars you select, and
  adds, updates or removes shared plans you approve on the one calendar you choose for
  the household. The event includes the plan's notes.
- Web Push (Apple, Google or Mozilla push services), on devices where you turned
  notifications on. Each notification has a title from a fixed set (such as "Fridgedoor
  reminder") and generic text such as a count. Plan titles and email content are never included.
- Web lookups by the planner (OpenAI, Azure OpenAI and Anthropic only). The planner
  sends short public search terms, such as a business name and town, plus the date and
  your time zone, through the AI provider's search tool. The provider's search may also open a public
  page you asked about, such as a recipe link.
- Shared Google Docs, Sheets or Slides links you give the planner: Fridgedoor downloads
  them directly from Google. Other links are not fetched by your server.

## On the server

- Email content, private plans, conversations with the planner, saved facts, calendar
  events, AI keys, email passwords and Google sign-in tokens are encrypted in the
  database. The key is stored next to it (`secret.key` in the data directory), so anyone
  with both the database and that file can read the data. Protect your backups.
- Shared plans, grocery and to-do items, text and links you send the planner, your
  mailbox address and calendar names are stored without that encryption.
- Each person's email is visible only to them. Clear everyday logistics found in it
  become shared suggestions automatically. Uncertain or personal items stay private
  until that person shares them, and so do medical items unless they turn on Share
  generic appointment logistics. Work email, and email from excluded senders or labels,
  doesn't become a suggestion at all. Household members see shared plans, shared lists
  and each other's names.
- The server operator (whoever has shell access to the machine) can technically read
  everything. That's usually you.
- Stored email is deleted seven days after Fridgedoor saves it. What you send the
  planner (photos, PDFs, text and links) and its replies are also deleted after seven
  days. Plans and lists stay until you delete them. Database backups keep older copies for as many days as `BACKUP_KEEP` (7 by default).
- Settings → Email → Delete my private data removes a person's private plans, stored
  email, attachments, conversations, saved facts and settings, then disconnects their
  mailbox. Plans they shared stay. It doesn't remove copies in existing backups, and
  for Google it doesn't revoke access on Google's side (do that at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions)).
- Logs contain error codes and job details, never email content, prompts or answers.
  Until setup is finished, the server prints the setup link (with its one-time token)
  to the log when it starts.
