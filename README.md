# Fridgedoor

**The family fridge door, as an app.** Fridgedoor reads the school newsletters, team
emails, flyers and invitations that pile up in your inbox, and turns them into a calm
shared plan for your household: what's happening today, what needs a decision, and the
grocery and to-do lists you both actually use.

It runs on a server you control (a $0 home computer, a free cloud VM or a ~$5/month
host) with the AI provider you choose. There is no Fridgedoor company in the middle.

- **Reads email for you.** Gmail, iCloud, Fastmail, Yahoo or any IMAP mailbox. Only
  things worth remembering become suggestions; you approve what goes on the calendar.
- **Today at a glance.** Your agenda, what needs a decision, and what's coming up,
  with a morning brief if you want one.
- **Ask the planner.** Type, speak, snap a flyer, share a PDF or a link: "dinner with
  the Parkers Friday 7pm", "add oat milk", "what's left for the bake sale?".
- **Shared lists.** Groceries sorted by store aisle, to-dos with due dates and owners.
- **Private by default.** Each person's email stays theirs: a plan is private until
  it's shared with the household. Stored data is encrypted on your server.
- **Works with any calendar.** Subscribe from Apple, Google or Outlook calendar, or
  connect Google Calendar to add events directly.
- **Native iPhone app** with widgets, Siri ("Ask Fridgedoor…"), the share sheet and
  reminders, plus a web app for everything else.
- **Any AI model.** OpenAI, Anthropic Claude, Google Gemini, OpenRouter, Groq,
  Mistral, DeepSeek, xAI, Together, Fireworks, Azure OpenAI, or a local model through
  Ollama, LM Studio, llama.cpp or vLLM. Switch any time in Settings.

## Set up

You need three things: somewhere to run it, an AI API key (or a local model), and an
email account to read. Setup takes about 20 minutes.

**Option A: let an AI coding agent do it.** If you use Claude Code, Codex or a similar
agent, open it in an empty folder and say:

> Set up Fridgedoor for my family by following
> https://github.com/ravimody/fridgedoor/blob/main/docs/setup-with-an-ai-agent.md

It will ask a few questions (where to host, which AI provider), run the commands, and
hand you a link to finish in your browser. Paste API keys into the Fridgedoor web page,
not into the agent's chat.

**Option B: do it yourself.** Pick a place to run it ([hosting guide](docs/hosting/README.md)):

| Where | Cost | Good for |
| --- | --- | --- |
| [A computer at home](docs/hosting/home-server.md) + Tailscale | $0 | Most private; no open ports |
| [Oracle Cloud / Google Cloud free VM](docs/hosting/vps.md) | $0 (with caveats) | No hardware at home |
| [Railway](docs/hosting/railway.md) or [Fly.io](docs/hosting/fly.md) | about $4-5/month | Least maintenance |
| [A small VPS](docs/hosting/vps.md) (Vultr, Linode, OVH...) | about $5/month | Full control |
| [Your NAS](docs/hosting/nas.md) (Synology, Unraid, TrueNAS) | $0 | Already have one |

On any Linux machine with internet access, one command installs Docker if needed,
starts Fridgedoor and prints your setup link:

```sh
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh | bash
```

Or with Docker Compose directly:

```sh
curl -fsSLO https://raw.githubusercontent.com/ravimody/fridgedoor/main/compose.yaml
docker compose up -d
docker compose exec fridgedoor fridgedoor setup-link
```

Open the setup link, create your household, then follow the steps in the browser:

1. **Choose an AI provider** and paste a key ([which one?](docs/ai-providers.md)).
2. **Connect email** with an app password ([how](docs/email.md)).
3. **Invite your partner** with a link.
4. **Connect your iPhone** by scanning a code ([iPhone app](docs/iphone.md)).
5. **Subscribe to the calendar** from the calendar app you already use.

## Privacy and costs

Your data lives in one SQLite file on your server. Email you connect and things you
send the planner are sent to the AI provider you chose, and to no one else; read
[what leaves your server](docs/privacy.md). AI usage for a typical family is a few
dollars a month with a mid-sized model, and less with a smaller model for email.

## Features

How each feature behaves, in more detail ([all feature docs](docs/features/README.md)):

- [Ask the planner](docs/features/assistant.md)
- [Email suggestions](docs/features/email-suggestions.md)
- [Morning brief](docs/features/morning-brief.md)
- [Household knowledge](docs/features/household-knowledge.md)
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

Node 22 or 24 (the SQLite driver doesn't build on newer releases yet). See
[AGENTS.md](AGENTS.md) for conventions, [docs/architecture.md](docs/architecture.md) for
how it fits together, [docs/configuration.md](docs/configuration.md) for every setting,
and [ios/README.md](ios/README.md) for the iPhone app.

What guides decisions: [VALUES.md](VALUES.md).

## License

The server, web app and shared packages are [AGPL-3.0](LICENSE): if you run a modified
version for other people, share your changes. The iPhone app in [`ios/`](ios/) is
[MPL-2.0](ios/LICENSE), which is compatible with App Store distribution.
