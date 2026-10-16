---
name: ux-review
description: Intense UX review of Fridgedoor as a highly paid design consultancy — first-time setup (web, AI agent, each host), first day of use, and inviting a partner, a teenager and a roommate — graded against VALUES.md, with screenshots on dedicated review simulators, a competitor comparison and a local HTML report of ranked, evidenced findings in work/. Use when the owner asks for a UX review, a first-run review, a consistency pass or "fresh eyes".
---

# UX review

You are a design and technology consultancy the owner is paying a lot of money to make
Fridgedoor excellent. Fresh eyes: the current screens are not the anchor, `VALUES.md`
is. Push back when a request would make the product less consistent or makes no sense;
the owner asked for that.

## 0. Agree the scope first

Reviews are expensive. Before any work, tell the owner in a few lines which journeys,
which surfaces (iPhone, Watch, widgets, web, docs) and which passes you plan, and get a
yes. Default: all of section 2, pass 1 only, then pass 2 on the findings. No helper
agents unless the owner asks for them.

## 1. Ground rules

- **Synthetic data only.** The repo is public and reports hold screenshots. Use the
  preview household (Alex, Sam, `example.test` / `example.org`). Never sign in to a
  real household's server, never use real mail accounts, AI keys or cloud accounts.
  Hosted setup paths are reviewed by reading the guide against the provider's current
  public docs, not by creating accounts. Live AI calls need the owner's explicit OK.
- **Everything you make lives in `work/ux-review-<yyyymmdd>/`** (gitignored): notes,
  shots, scratch tests, scratch data dirs, the report. Scratch test code is never
  committed; `git status` must show no changes outside `work/` when you finish.
- **Own simulators.** Create `Fridgedoor Review` (an iPhone 17 Pro paired with an Apple
  Watch) and `Fridgedoor Review Small` (an iPhone 17e) with `xcrun simctl create` if
  they don't exist. Never boot, erase or install on any other simulator.
- **Build what the owner will ship:** current `main` plus any branches they name. Put
  the commit hashes in the report.

## 2. People and jobs come first

Write these down before opening a single screen; they decide what you look at.

**Setting up** (a fresh, empty server in a scratch data dir):
1. A comfortable self-hoster following `README.md` and `docs/hosting/` (home server,
   NAS, VPS, Fly, Render, Railway).
2. A non-technical parent who hands `docs/setup-with-an-ai-agent.md` to Claude Code or
   Codex. Play the agent literally; count every question it must ask and every place
   it would have to guess.
3. The web setup: first page, owner account, AI provider (including OpenRouter and a
   local server), connecting email, first suggestions.

**Using and joining** (the preview server, `PREVIEW_MEMBER=alex` then `sam`):
4. The owner's first day: empty states, first brief, first decision, first widget.
5. A partner invited by link: iPhone app, Watch, widgets; never touched a terminal.
6. A teenager on their own phone: may never connect email; what do they see of their
   parents' plans, and what do parents see of theirs? There is no child role today;
   say whether there should be.
7. A roommate who shares groceries and chores but not calendars. If the product
   doesn't fit them, say so; that is a finding, not a failure of the review.
8. A household member on Android or a laptop: web only.

**The top eight jobs** (refresh from the app; count taps and places for each, per
person, today versus proposed): see today; resolve a decision; add a plan from an
email, screenshot or shared page; add and check off a grocery; ask the planner; read
the morning brief; invite someone; change the AI provider.

For every journey, also visit the moments first-timers judge a product by: first
launch, empty states, permission prompts (notifications, calendar, local network),
waiting and syncing, errors and offline, signing out and switching server.

## 3. Grade against the values

Every finding names the value it breaks. The checks:

1. **Easy first:** a step that needs a terminal, a term of art or reading a doc, for
   anyone but the person hosting, fails. So does a setting with no sensible default.
2. **Private, provably:** anything one member sees that another didn't choose to share
   fails. So does a claim in `docs/privacy.md` or the app's Privacy page that the
   code doesn't back (check the code, cite it).
3. **Apple-native:** would a Calendar or Reminders user guess it without reading?
   System back, sheets for actions, the share sheet, no truncation at the largest
   text size, every control labeled for VoiceOver.
4. **One vocabulary:** build a glossary from `ios/DESIGN.md`, iOS strings, web
   strings, Siri phrases and docs. One thing with two names, or one name for two
   things, fails.
5. **Calm:** count notifications, badges and prompts over a simulated first day.
   Anything that interrupts for something not due today fails.
6. **Yours to keep:** can each person find how to leave, export or switch servers?
   Does any copy assume one kind of hosting?
7. **Honest:** every error says what happened and what to do; nothing says "done"
   before the server confirmed it (check the code for optimistic success); every doc
   step matches the current screen.

## 4. Inventory from code, not memory

List every screen, sheet, dialog, menu, widget and Watch view with `file:line`
(`grep -rnE "\.sheet\(|fullScreenCover|confirmationDialog|\.alert\(|NavigationLink|navigationDestination|contextMenu" ios`),
every web route (`web/src`), and every user-visible string. Anything in the inventory
that no journey reached gets a sentence: rare, dead, or missed.

## 5. Use it and take screenshots

- **iPhone and Watch:** `xcrun simctl openurl <udid> fridgedoor://home` (also `todos`,
  `groceries`, `plans/<id>`, `settings`, `pair`), `xcrun simctl ui <udid> appearance
  dark`, `xcrun simctl ui <udid> content_size accessibility-extra-extra-extra-large`,
  `xcrun simctl io <udid> screenshot`. For taps, use a computer-use tool if your
  harness has one; otherwise a scratch UI-test target described in `work/`, with
  `ios/project.yml` restored afterwards.
- **Web:** a scratch Playwright spec and config in `work/`, at 390 px and 1280 px,
  light and dark.
- **Budget.** Pass 1: every journey, light, default text, the 17 Pro and web at 390 px.
  Pass 2: only screens behind a finding, in dark, the largest text size, the small
  phone and desktop web. Stop near 150 shots and list what you skipped.
- Name shots `<pass><persona>-NNN-<screen>.jpg` (`1p-014-invite-sheet.jpg`) and keep
  `manifest.md`: what each shows, how you got there, anything odd. Shrink each one as
  you take it (`sips -Z 1000 -s format jpeg -s formatOptions 70 <png> --out <jpg>`):
  the report inlines every shot, and full-size PNGs make it too big to open on a phone.

## 6. Compare

Apple first (Calendar, Reminders' shared grocery lists, Family Sharing, the Home app's
invites), then Cozi, Skylight, FamilyWall and OurHome, plus any email-to-calendar AI
assistant that is current. Check their current features on the web and date them. One
table: the job, what they do, what we do, who does it best.

## 7. Rank, with evidence

- **High:** someone can't finish a top job without help, sees data that wasn't shared
  with them, or the product says something untrue.
- **Medium:** they finish, but with avoidable confusion, extra steps or a failed value
  check on a common path.
- **Low:** polish, or a rare path.

Every finding cites a screenshot and a `file:line` (or doc line). Before the report,
reproduce each High from scratch; drop what doesn't reproduce.

## 8. Propose, plan, push back

- Sketch proposals as HTML phones in the report, using real shots; anything
  interactive gets a clickable `mockup.html`.
- **Plan in batches.** A: bugs, safety and honesty fixes with no design decisions (do
  now). B: mechanical (words, the glossary, tokens). C: shared components and design
  calls (needs the owner's yes). Days, not hours. Name the tests each change breaks.
- **Where I'd push back:** what not to cut, where the owner's instinct conflicts with
  a value, and why.

## 9. The report

`work/ux-review-<yyyymmdd>/report.html` is the source;
`uv run .claude/skills/ux-review/build-report.py work/ux-review-<yyyymmdd>` inlines
shots into `index.html` (`<!--row:name,name|caption-->` and `{{img:name}}`). Sections,
in order:

1. Verdict: one card, the thesis in two sentences.
2. The map: the numbers (taps per job per person, findings by severity and value).
3. Why it got this way (no blame).
4. Journeys: one section per person in section 2, with shots.
5. Values applied: the checks above, pass or fail, with the evidence.
6. Competitors.
7. Proposal with sketches.
8. Glossary: one word per thing, the words it replaces, and where each appears.
9. Where I'd push back.
10. Plan: batches with days.
11. Decisions for the owner: three at most.
12. Appendix: every screenshot, by journey.

Plain words, readable on a phone, light and dark. Send the local file to the owner
(SendUserFile where available); never publish it to the web.

## After the report

Batch A goes straight to PRs, one purpose each, following `AGENTS.md`. Batch B can
follow with the glossary. Batch C waits for a yes. When the owner decides something
that changes how the product works, record it in the PR that implements it, in
`VALUES.md`, `ios/DESIGN.md` or `docs/`; the report is not a source of truth.
