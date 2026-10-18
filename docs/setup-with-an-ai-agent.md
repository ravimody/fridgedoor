# Setting up Fridgedoor with an AI coding agent

This page is written for an AI coding agent (Claude Code, Codex, Cursor, Gemini CLI...)
helping someone install Fridgedoor.

## Your job

Get a working Fridgedoor server running for this household, reachable over HTTPS, and
give the person a setup link to open in their browser. The person finishes setup in
the web app: household, AI provider, email, calendar, invites, and adding it to their
phone. Plan on 5-10 minutes of the person's attention. They may not be technical.

## Ground rules

1. Never ask for secrets in chat. AI API keys and email app passwords go into the
   Fridgedoor web app after setup, not into this conversation. A hosting step may need
   a token (Tailscale auth key, Cloudflare tunnel token, a cloud API token). Ask the
   person to paste it into a hidden prompt (`deploy/install.sh` asks for these with
   input hidden) or into the server's `.env` file themselves. Never echo it back.
2. Use the person's accounts, with their consent. Creating cloud resources can cost
   money. Before creating anything billable, say what it is and roughly what it costs
   per month, and wait for a yes.
3. Prefer the simplest path. The Docker image `ghcr.io/ravimody/fridgedoor:latest`
   plus `compose.yaml` covers almost everything. Don't build from source unless asked.
4. Verify each step. Each step below ends with a check. Report what you saw.

## 1. Ask a few questions

Ask these together, in plain language, with your recommendation:

- Where should it run?
  - A computer that's always on at home (Linux PC, Mac mini, Raspberry Pi 5, NAS).
  - A server they already have and can SSH into.
  - A free cloud VM (Oracle Cloud Always Free, Google Cloud e2-micro).
  - A managed host (Railway or Fly.io, about $4-5/month, with the least maintenance).
- How will phones reach it?
  - Tailscale: free, no open ports, works at home. Recommended unless they have a domain.
  - Their own domain name pointed at the server.
  - A Cloudflare Tunnel, if their domain is already on Cloudflare.
  - Managed hosts provide an HTTPS address automatically.
- Which AI provider? If they're unsure, suggest Anthropic or OpenAI for quality,
  OpenRouter for choice, or Ollama if they want everything local (it needs a strong
  computer). They'll paste the key into the web app later; see
  [ai-providers.md](ai-providers.md).
- Which email will Fridgedoor read? Gmail, iCloud, Fastmail and Yahoo all work with
  an app password; see [email.md](email.md). There's nothing to do yet.

If they have no preference, recommend an always-on home computer with Tailscale if they
have one, and Railway otherwise.

## 2. Install

### A Linux machine you can reach (home server, VPS, cloud VM)

Run the installer on that machine (over SSH if needed). It installs Docker when
missing, writes `compose.yaml` and `.env` into `/opt/fridgedoor` (or `~/fridgedoor`
when not run as root; set `FRIDGEDOOR_DIR` to choose), starts the containers and prints
the setup link. You can pass every answer as an environment variable:

```sh
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh -o install.sh

# Tailscale (the person pastes the auth key into the hidden prompt, or into .env first)
FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=tailscale bash install.sh

# Their own domain (DNS A/AAAA record already points here; ports 80 and 443 open)
FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=domain DOMAIN=fridgedoor.example.com bash install.sh

# Cloudflare Tunnel (the tunnel's public hostname routes to http://fridgedoor:8080)
FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=cloudflare PUBLIC_HOST=fridgedoor.example.com bash install.sh
```

Tailscale needs an auth key from https://login.tailscale.com/admin/settings/keys and
HTTPS certificates turned on (DNS page of the admin console). By default the installer
uses Funnel so phones without the Tailscale app can connect, which must be allowed for
the machine ([home-server.md](hosting/home-server.md)). Add `TS_FUNNEL=false` to keep it
reachable only from devices signed in to their tailnet.

Check: the script ends with `Fridgedoor is running` and a link. Also run
`docker compose ps` in the install folder (the `fridgedoor` service should be
`healthy`) and `curl -fsS https://<their address>/healthz` from any machine
(`{"data":{"status":"ok"}}`).

### A new cloud VM

Create an Ubuntu 24.04 VM with the provider's CLI, passing
[`deploy/cloud-init.yaml`](../deploy/cloud-init.yaml) as user data after editing its
last line (HTTPS mode and domain or Tailscale key). Open ports 80 and 443 only for
the domain mode. Details per provider (Oracle, Google Cloud, AWS, DigitalOcean, Vultr,
Linode, OVH, Hetzner) are in [hosting/vps.md](hosting/vps.md). The setup link ends up
in `/var/log/fridgedoor-install.log` on the VM.

### Railway, Fly.io or Render

Follow [hosting/railway.md](hosting/railway.md), [hosting/fly.md](hosting/fly.md) or
[hosting/render.md](hosting/render.md). Each one needs a persistent volume at `/data`
and a single always-on instance. `fly.toml` and `render.yaml` set the proxy settings
(`TRUST_PROXY`, `CLIENT_IP_HEADER`) and the health check. Railway has no config file, so
set `TRUST_PROXY=true`, `CLIENT_IP_HEADER=X-Real-IP`, the `/healthz` health check and the
volume yourself, as the Railway guide describes. The setup link is in the deploy logs, or run
`fridgedoor setup-link` in the instance's shell.

### macOS or Windows with Docker Desktop (or OrbStack)

```sh
mkdir fridgedoor && cd fridgedoor
curl -fsSLO https://raw.githubusercontent.com/ravimody/fridgedoor/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/.env.example -o .env
docker compose up -d
docker compose exec fridgedoor fridgedoor setup-link
```

To use Tailscale here, put `TS_AUTHKEY` in `.env`, download the Tailscale config next
to `compose.yaml`, and start with the profile:

```sh
mkdir -p deploy
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/tailscale-serve.json -o deploy/tailscale-serve.json
docker compose --profile tailscale up -d
```

The computer has to stay on and awake for email checks and reminders.

## 3. Give them the setup link

The link looks like `https://<address>/dashboard/setup?token=…`. If the printed link
starts with `http://localhost:8080`, replace that part with the address phones will use
(the Tailscale `https://<name>.<tailnet>.ts.net`, their domain, or the platform URL).
The setup token works once. Until setup is done, `fridgedoor setup-link` prints the same
link again.

Tell the person what to expect in the browser:

1. Create the household and their account.
2. Choose an AI provider and paste the API key there (the page can test it).
3. Connect their email with an app password ([email.md](email.md)).
4. Subscribe to their Fridgedoor calendar from the calendar app they already use.
5. Invite the other people in the household with a link.
6. Add Fridgedoor to their phone: open it in Safari, tap Share, then Add to Home Screen.
   The [iPhone app](iphone.md) has to be built with Xcode because it isn't in the App
   Store yet, so only offer it if they build apps.

Every step after the first can be skipped and done later in Settings.

## 4. Confirm it works

Ask the person to tell you when the setup page says they're done, then check:

- `docker compose logs --since 10m fridgedoor` shows no repeated errors. Codes such as
  `IMAP_AUTH_FAILED`, `AI_AUTH_FAILED` or `AI_PROVIDER_FAILED` mean a password or key
  needs fixing in Settings.
- `https://<address>/healthz` returns `ok`. `degraded` means the background worker
  stopped, so restart the container.
- Test connection succeeds in Settings → AI, and Settings → Email shows the mailbox
  status as Checking for new email.

## 5. Leave it maintainable

Fridgedoor saves a copy of its database once a day (the last 7 days) in the
`fridgedoor-data` volume under `backups/`. Those copies live on the same disk. The
person may have somewhere else to keep files (a NAS, another computer, cloud storage). If
so, set up a nightly copy of the newest backup and `secret.key` to it, and tell them where
it goes.
To upgrade, run the installer again, which also downloads the current `compose.yaml`
(it pins the Caddy, Tailscale and cloudflared versions). On Docker Desktop, download
`compose.yaml` again, then run `docker compose --profile <same profile> pull && docker compose --profile <same profile> up -d`.

Finish with a short summary for the person: where it runs, its address, how much it
costs per month, how to upgrade, and where backups go.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Setup page says the link is invalid | The token was mistyped, or setup is already done. Run `fridgedoor setup-link`: it prints the link again, or says setup is done and where to sign in. |
| Setup fails with "forbidden" | The page was opened at a different address than the server sees. Open it at the public address, or set `PUBLIC_URL` in `.env` and restart. |
| Sign-in works on one address but not another | Fridgedoor accepts one public address. Change it in Settings → Server, or run `fridgedoor public-url https://…` and restart. |
| iPhone app can't connect | It needs HTTPS (or a local network address). Check that the address works in Safari on the phone. |
| The `caddy`, `tailscale` or `cloudflared` container keeps restarting | Its value is missing from `.env`: `DOMAIN`, `TS_AUTHKEY` or `TUNNEL_TOKEN`. Check `docker compose logs <service>`. |
| Container restarts with permission errors on `/data` | A bind mount owned by another user. Use the named volume from `compose.yaml`, or run `chown -R 1000:1000` on the folder. |
| Out of memory on a 1 GB VM | Add swap (the cloud-init file does this). |
