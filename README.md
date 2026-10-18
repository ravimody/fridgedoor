# Fridgedoor

[fridgedoor.dev](https://fridgedoor.dev)

Fridgedoor is a household planner that you run on your own server. It reads the school
newsletters, team emails, flyers and invitations in your inbox, suggests the plans in
them, and keeps the household's calendar, grocery list and to-do list in one place.
Everyone in the household signs in with their own account.

It runs on a computer at home for $0, on a free cloud VM, or on a host for about $5 a
month, and it uses the AI provider you choose. There is no Fridgedoor account or hosted
service.

- It reads email from Gmail, iCloud, Fastmail, Yahoo or any IMAP mailbox. Plans it finds
  in email wait for someone to accept them before they reach the calendar.
- Home shows today's agenda, what needs a decision and what's coming up. A morning brief
  can sum up the day each morning.
- You can ask the planner by typing, speaking, attaching a photo or PDF, or pasting a
  link. For example: "dinner with the Parkers Friday 7pm", "add oat milk", "what's left
  for the bake sale?".
- The household shares grocery and to-do lists.
- Each person's email stays theirs. Clear everyday logistics found in it become
  suggestions for the household, and anything uncertain, personal or medical stays
  private until that person shares it. Email content and private plans are encrypted on
  your server.
- Apple, Google and Outlook calendars can subscribe to your Fridgedoor calendar. With a
  Google connection, Fridgedoor can also add events to Google Calendar directly.
- Everyone can use the web app and add it to their phone's Home Screen. There is also a
  native iPhone app with widgets, Siri ("Ask Planner"), the share sheet, reminders and an
  Apple Watch app. It isn't in the App Store yet, so it's only for people who build it
  themselves with Xcode ([details](docs/iphone.md)).
- It works with OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Groq, Mistral,
  DeepSeek, xAI, Together, Fireworks, Azure OpenAI, or a local model through Ollama, LM
  Studio, llama.cpp or vLLM. You can switch at any time in Settings.

## Set up

You need somewhere to run it, an AI API key (or a local model), and an email account to
read. Setup takes about 20 minutes.

The easiest way is to let an AI coding agent do it. If you use Claude Code, Codex or a
similar agent, open it in an empty folder and say:

> Set up Fridgedoor for my household by following
> https://github.com/ravimody/fridgedoor/blob/main/docs/setup-with-an-ai-agent.md

It will ask a few questions (where to host, which AI provider), run the commands, and
give you a link to finish in your browser. Paste API keys into the Fridgedoor web page,
not into the agent's chat.

To do it yourself, pick a place to run it ([hosting guide](docs/hosting/README.md)):

| Where | Cost | Good for |
| --- | --- | --- |
| [A computer at home](docs/hosting/home-server.md) + Tailscale | $0 | Most private; no open ports |
| [Oracle Cloud or Google Cloud free VM](docs/hosting/vps.md) | $0 to about $4/month | No hardware at home |
| [Railway](docs/hosting/railway.md) or [Fly.io](docs/hosting/fly.md) | about $4-5/month | Least maintenance |
| [A small VPS](docs/hosting/vps.md) (Vultr, Linode, OVH) | about $5/month | Full control |
| [Your NAS](docs/hosting/nas.md) (Synology, Unraid, TrueNAS) | $0 | Already have one |

On a Linux machine with internet access, one command installs Docker if needed, starts
Fridgedoor and prints your setup link:

```sh
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh | bash
```

Or with Docker Compose directly:

```sh
curl -fsSLO https://raw.githubusercontent.com/ravimody/fridgedoor/main/compose.yaml
docker compose up -d
docker compose exec fridgedoor fridgedoor setup-link
```

If you open the setup link from another computer, replace the address in front of
`/dashboard` with the one you use to reach the server. Create your household, then follow
the steps in the browser:

1. Choose an AI provider and paste a key ([which one?](docs/ai-providers.md)).
2. Connect email with an app password ([how](docs/email.md)).
3. Subscribe to the calendar from the calendar app you already use.
4. Invite the other people in your household with a link. They join in their phone's
   browser.
5. Put Fridgedoor on your phone. On an iPhone, open it in Safari, tap Share, then Add to
   Home Screen. On Android, open it in Chrome and choose Add to Home screen. If you build
   the [iPhone app](docs/iphone.md), connect it by scanning a code.

## Privacy and costs

Your data lives in one SQLite file on your server. Email you connect and things you send
the planner go to the AI provider you chose, and [what leaves your
server](docs/privacy.md) lists every case.

You pay the AI provider directly. Most of the cost is reading email: a household that gets
50 emails a day uses roughly 5 to 15 million input tokens a month. That is a few dollars
with a small model and tens of dollars with a large one. [AI
providers](docs/ai-providers.md#costs) shows how to estimate it and how to cap it.

## Features

Each feature is described in more detail in [the feature docs](docs/features/README.md):

- [Ask the planner](docs/features/assistant.md)
- [Email suggestions](docs/features/email-suggestions.md)
- [Morning brief](docs/features/morning-brief.md)
- [Household facts](docs/features/household-facts.md)
- [Notifications](docs/features/notifications.md)
- [Home and the Linen & Teal design](docs/features/home-design.md) (for contributors)

## For developers

```sh
corepack enable && pnpm install
pnpm --filter @fridgedoor/contracts build
PUBLIC_URL=http://127.0.0.1:4173 pnpm --filter @fridgedoor/server dev   # API + worker on :8080
pnpm --filter @fridgedoor/web dev           # http://127.0.0.1:4173/dashboard/ (proxies the API)
pnpm test
```

Use Node 22 or 24 (the SQLite driver doesn't build on newer releases yet). See
[AGENTS.md](AGENTS.md) for conventions, [docs/architecture.md](docs/architecture.md) for
how it fits together, [docs/configuration.md](docs/configuration.md) for every setting,
[ios/README.md](ios/README.md) for the iPhone app, and [VALUES.md](VALUES.md) for what
guides decisions.

## License

The server, web app and shared packages are [AGPL-3.0](LICENSE): if you run a modified
version for other people, you must share your changes. The iPhone app in [`ios/`](ios/)
is [MPL-2.0](ios/LICENSE), which is compatible with App Store distribution.
