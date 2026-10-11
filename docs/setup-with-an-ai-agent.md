# Setting up Fridgedoor with an AI coding agent

This page is written for an AI coding agent (Claude Code, Codex, Cursor, Gemini CLI...)
helping someone install Fridgedoor. People are welcome to read it too.

## Your job

Get a working Fridgedoor server running for this household, reachable over HTTPS, and
hand the person a setup link to open in their browser. The person finishes setup in
the web app (household, AI provider, email, partner invite, iPhone pairing). Plan on
5-10 minutes of the person's attention; they may not be technical.

## Ground rules

1. **Never ask for secrets in chat.** AI API keys and email app passwords go into the
   Fridgedoor web app after setup, not into this conversation. If a hosting step needs
   a token (Tailscale auth key, Cloudflare tunnel token, a cloud API token), ask the
   person to paste it into a hidden prompt (`deploy/install.sh` asks for these with
   input hidden) or into the server's `.env` file themselves, and never echo it back.
2. **Use the person's accounts, with their consent.** Creating cloud resources can cost
   money. Before creating anything billable, say what it is and roughly what it costs
   per month, and wait for a yes.
3. **Prefer the boring path.** The Docker image `ghcr.io/ravimody/fridgedoor:latest`
   plus `compose.yaml` covers almost everything. Don't build from source unless asked.
4. **Verify, don't assume.** Each step below ends with a check. Report what you saw.

## 1. Ask a few questions

Ask these together, in plain language, with your recommendation:

- **Where should it run?**
  - A computer that's always on at home (Linux PC, Mac mini, Raspberry Pi 5, NAS).
  - A server they already have and can SSH into.
  - A free cloud VM (Oracle Cloud Always Free, Google Cloud e2-micro).
  - A managed host (Railway or Fly.io, about $4-5/month; least maintenance).
- **How will phones reach it?**
  - Tailscale: free, no open ports, works at home. Recommended unless they have a domain.
  - Their own domain name pointed at the server.
  - A Cloudflare Tunnel, if their domain is already on Cloudflare.
  - Managed hosts provide an HTTPS address automatically.
- **Which AI provider?** If unsure: Anthropic or OpenAI for quality, OpenRouter for
  choice, Ollama if they insist on fully local (needs a strong computer). They'll paste
  the key into the web app later; see [ai-providers.md](ai-providers.md).
- **Which email** will Fridgedoor read? Gmail, iCloud, Fastmail and Yahoo all work with
  an app password; see [email.md](email.md). Nothing to do yet.

Recommendation when they have no preference: **an always-on home computer with
Tailscale** if they have one, otherwise **Railway**.

## 2. Install

### A Linux machine you can reach (home server, VPS, cloud VM)

Run the installer on that machine (over SSH if needed). It installs Docker when
missing, writes `/opt/fridgedoor/{compose.yaml,.env}`, starts the containers and prints
the setup link. Everything can be passed as environment variables:

```sh
# Tailscale (the person pastes the auth key into the hidden prompt, or into .env first)
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh -o install.sh
FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=tailscale bash install.sh

# Their own domain (DNS A/AAAA record already points here; ports 80 and 443 open)
FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=domain DOMAIN=fridgedoor.example.com bash install.sh

# Cloudflare Tunnel (tunnel's public hostname routes to http://fridgedoor:8080)
FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=cloudflare PUBLIC_HOST=fridgedoor.example.com bash install.sh
```

Tailscale needs an auth key from https://login.tailscale.com/admin/settings/keys, HTTPS
certificates enabled (DNS page), and Funnel allowed for the node if phones without the
Tailscale app should connect ([home-server.md](hosting/home-server.md)).

**Check:** the script ends with `Fridgedoor is running` and a link. Also run
`cd /opt/fridgedoor && docker compose ps` (the `fridgedoor` service should be
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
[hosting/render.md](hosting/render.md). Every one needs a persistent volume at `/data`
and a single always-on instance. The setup link is in the deploy logs, or run
`fridgedoor setup-link` in the instance's shell.

### macOS or Windows with Docker Desktop (or OrbStack)

```sh
mkdir fridgedoor && cd fridgedoor
curl -fsSLO https://raw.githubusercontent.com/ravimody/fridgedoor/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/.env.example -o .env
docker compose up -d            # add --profile tailscale after putting TS_AUTHKEY in .env
docker compose exec fridgedoor fridgedoor setup-link
```

The computer has to stay on and awake for email checks and reminders.

## 3. Hand over the setup link

The link looks like `https://<address>/dashboard/setup?token=…`. If the printed link
starts with `http://localhost:8080`, replace that part with the address phones will use
(the Tailscale `https://<name>.<tailnet>.ts.net`, their domain, or the platform URL).
The setup token works once; `fridgedoor setup-link` prints it again until setup is done.

Tell the person what to expect in the browser:

1. Create the household and their account.
2. Choose an AI provider and paste the API key there (the page can test it).
3. Connect their email with an app password ([email.md](email.md)).
4. Invite their partner and pair their iPhone by scanning a code ([iphone.md](iphone.md)).

## 4. Confirm it works

Ask the person to tell you when the setup page says they're done, then check:

- `docker compose logs --since 10m fridgedoor` shows no repeated errors (codes such as
  `IMAP_AUTH_FAILED` or `AI_AUTH_FAILED` mean a password or key needs fixing in Settings).
- `https://<address>/healthz` returns `ok`. `degraded` means the background worker
  stopped; restart the container.
- Settings → AI shows a successful connection test, and Settings → Email shows a recent
  sync after a few minutes.

## 5. Leave it maintainable

Fridgedoor keeps a copy of its database every night (the last 7 days) in the
`fridgedoor-data` volume under `backups/`. Those copies live on the same disk, so if the
person has somewhere else to keep files (a NAS, another computer, cloud storage), set up
a nightly copy of the newest backup and `secret.key` to it, and tell them where it goes.
Upgrading is `docker compose pull && docker compose --profile <same profile> up -d`.

Finish with a short summary for the person: where it runs, its address, how much it
costs per month, how to upgrade, and where backups go.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Setup page says the link is invalid | Token already used or mistyped. Run `fridgedoor setup-link`. |
| Setup fails with "forbidden" | The page was opened at a different address than the server sees. Open it at the public address, or set `PUBLIC_URL` in `.env` and restart. |
| Sign-in works on one address but not another | Fridgedoor accepts one public address. Change it in Settings → Server, or `fridgedoor public-url https://…`. |
| iPhone app can't connect | It needs HTTPS (or a local network address). Check the address works in Safari on the phone. |
| The `caddy`, `tailscale` or `cloudflared` container keeps restarting | Its value is missing from `.env`: `DOMAIN`, `TS_AUTHKEY` or `TUNNEL_TOKEN`. Check `docker compose logs <service>`. |
| Container restarts with permission errors on `/data` | A bind mount owned by another user. Use the named volume from `compose.yaml`, or `chown -R 1000:1000` the folder. |
| Out of memory on a 1 GB VM | Add swap (the cloud-init file does this). |
