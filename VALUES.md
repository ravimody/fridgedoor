# Values

What Fridgedoor is trying to be. When two good options conflict, these decide. Each
value ends with a question to ask of any change and a test: a screen, flow or doc that
fails the test is a bug, not a matter of taste.

## 1. Easy first, powerful underneath

A family member should get value in minutes without reading anything. The power (any AI
provider, any mailbox, any host) is there, but never in the way.

*Could a busy, non-technical parent do this without help? If not, the default is wrong,
not the parent.*

**Test:** a step that needs a terminal, a term of art or reading a doc fails, for anyone
but the person hosting. So does a setting with no sensible default.

## 2. Private by default, provably

Each person's email stays theirs. Nothing leaves the server except to services the
household chose. No telemetry, no company in the middle. The docs say exactly what goes
where, and match the code.

*Would you be comfortable reading the privacy page out loud to your partner?*

**Test:** anything one member sees that another didn't choose to share fails. So does any
claim in the docs or the app's Privacy page that the code doesn't back.

## 3. Apple-native, not Apple-only

The iPhone app should feel like Apple made it: widgets, Siri, the share sheet, platform
conventions over custom ones. The web app keeps everyone else included.

*Does this behave the way Apple's own apps do?*

**Test:** would a Calendar or Reminders user guess it without reading? The system back,
sheets for actions, the system share sheet, no cut-off text at the largest text size,
and every control labeled for VoiceOver.

## 4. One vocabulary, everywhere

The same words, names and flows in the iPhone app, web app, docs and Siri: "the
planner", "household", "Settings → Email". If a name changes, it changes everywhere.

*Could someone switch between phone and web without noticing a different product?*

**Test:** one thing with two names, or one name for two things, across the app, web,
Siri and docs fails.

## 5. Calm, not busy

The planner remembers so people don't have to. The morning brief is where things get
resolved; interruptions are rare and same-day only. Fewer, better suggestions beat more.

*Does this earn the attention it asks for?*

**Test:** over a first day, anything that interrupts (a notification, badge or prompt)
for something not due today fails.

## 6. Yours to keep, wherever it runs

Fridgedoor works fully when you run it yourself, and may one day also run as a paid
hosted service for people who'd rather not. Both are first-class, and households can
move between them.

- Same app and data format: a household can move from hosted to self-hosted, or back,
  in an afternoon.
- Hosted sells convenience, not hostages. It can offer what's hard to run alone
  (managed servers and backups, push through Apple's service, email forwarding
  addresses), but never locks data in, and self-hosting is never deliberately crippled.
- Any AI provider either way, including bring-your-own-key on hosted.

*Could a household leave, in either direction, without losing anything?*

**Test:** each person can find how to export, leave or switch servers from the app, and
no copy assumes one kind of hosting.

## 7. Honest software

Errors say what happened and how to fix it. The app never claims something was done
when it wasn't. Docs describe what the code does today, not what we wish it did.

*Is every claim on screen and in the docs true right now?*

**Test:** every error says what happened and what to do; nothing says "done" before the
server confirmed it; every step in the docs matches the current screen.
