# Values

These values decide between two good options when they conflict. Each one ends with a
question to ask of any change and a test. A screen, flow or doc that fails the test is a
bug to fix.

## 1. Easy first, powerful underneath

A household member should get value in minutes without reading anything. The options
(any AI provider, any mailbox, any host) are available, but nobody has to deal with them
to get started.

*Could a busy, non-technical parent do this without help? If not, change the default.*

Test: for anyone but the person hosting, a step that needs a terminal, a technical term
or reading a doc fails. So does a setting with no sensible default.

## 2. Private by default, provably

Each person's email stays theirs. Nothing leaves the server except to services the
household chose. There is no telemetry and no company in the middle. The docs say exactly
what goes where, and they match the code.

*Would you be comfortable reading the privacy page out loud to the rest of your household?*

Test: anything one member sees that another didn't choose to share fails. So does any
claim in the docs or the app's Privacy page that the code doesn't back.

## 3. Apple-native, not Apple-only

The iPhone app should feel like Apple made it: widgets, Siri, the share sheet, and
platform conventions over custom ones. The web app keeps everyone else included.

*Does this behave the way Apple's own apps do?*

Test: a Calendar or Reminders user can use it without reading anything. That means the
system back gesture, sheets for actions, the system share sheet, no cut-off text at the
largest text size, and a VoiceOver label on every control.

## 4. One vocabulary, everywhere

The iPhone app, web app, docs and Siri use the same words, names and flows: "the
planner", "household", "Settings → Email". If a name changes, it changes everywhere.

*Could someone switch between phone and web without noticing a different product?*

Test: one thing with two names, or one name for two things, across the app, web, Siri
and docs fails.

## 5. Calm, not busy

The planner remembers so people don't have to. The morning brief is where things get
resolved. Interruptions are rare and only for things due the same day. A few good
suggestions are better than many.

*Is this worth the attention it asks for?*

Test: over a first day, anything that interrupts (a notification, badge or prompt) for
something not due today fails.

## 6. Yours to keep, wherever it runs

Fridgedoor works fully when you run it yourself. It may one day also run as a paid
hosted service for people who'd rather not, and both kinds of hosting are treated as
equals. Both use the same app and data format, so a household can move from hosted to
self-hosted, or back, in an afternoon. A hosted service may offer things that are hard to
run alone, such as managed servers and backups, push through Apple's service, and email
forwarding addresses. It never locks data in, and self-hosting is never deliberately
limited.
Either way, any AI provider works, including your own key on a hosted server.

*Could a household leave, in either direction, without losing anything?*

Test: each person can find how to export, leave or switch servers from the app, and no
text assumes one kind of hosting.

## 7. Honest software

Errors say what happened and how to fix it. The app never claims something was done
when it wasn't. Docs describe what the code does today, not what we wish it did.

*Is every claim on screen and in the docs true right now?*

Test: every error says what happened and what to do, nothing says "done" before the
server confirmed it, and every step in the docs matches the current screen.
