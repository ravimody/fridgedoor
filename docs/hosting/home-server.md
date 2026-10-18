# Run Fridgedoor on a computer at home

Any computer that stays on all the time can run Fridgedoor for free. On Linux, one installer command sets everything up. For a NAS, see the [NAS guide](nas.md) instead.

## 1. Pick the computer

- An old PC or a mini PC running Linux (Ubuntu, Debian). This is the most reliable choice, and you may already own one.
- A Raspberry Pi 5 running 64-bit Raspberry Pi OS. Boot it from an SSD or NVMe drive, not a microSD card: the database writes often, and SD cards wear out. 2 GB of memory or more is plenty.
- A Mac mini or Windows PC with Docker Desktop. Turn off sleep, or Fridgedoor stops when the computer does. The installer below is for Linux. On a Mac or Windows PC, use the [manual steps](#mac-or-windows-docker-desktop).

The computer must be 64-bit, have at least 1 GB of free memory, and stay on and connected to the internet all the time.

## 2. Install Docker

On Linux you can skip this step. The installer offers to install Docker for you with Docker's official script.

To install it yourself, see:

- Linux: <https://docs.docker.com/engine/install/>
- Mac or Windows: Docker Desktop, <https://docs.docker.com/desktop/>

## 3. Choose how phones will reach Fridgedoor

Decide this before you run the installer, because it asks.

| | Tailscale | Cloudflare Tunnel | Home network only |
|---|---|---|---|
| Cost | Free | Free, plus a domain (about $10/year) | Free |
| Works away from home | Yes | Yes | No |
| Opens ports on your router | No | No | No |
| Address | `https://fridgedoor.<your-tailnet>.ts.net` | `https://fridgedoor.yourdomain.com` | `http://192.168.x.x:8080` |
| Good for | Most families | People who want their own domain | Trying it out |

Prices as of October 2026. Read [HTTPS explained](https.md) for more detail.

For Tailscale or Cloudflare, do the account setup in [Option A](#option-a-tailscale) or [Option B](#option-b-cloudflare-tunnel) first, so you have the key or token ready when the installer asks for it.

## 4. Run the installer

On the Linux computer, run:

```sh
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh | bash
```

The installer:

1. installs Docker if it's missing (it asks first)
2. puts its files in `/opt/fridgedoor` if you're root, or `~/fridgedoor` if you're not
3. asks how phones should reach Fridgedoor (step 3)
4. starts Fridgedoor
5. prints a one-time setup link

Open that link in a browser to create your household.

If you run the installer as a normal user, Docker commands may need `sudo` in front of them. To avoid that, run `sudo usermod -aG docker $USER`, then log out and back in.

### Answering the questions ahead of time

AI agents and scripts can answer every question with environment variables. For example:

```sh
curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh -o install.sh
FRIDGEDOOR_YES=1 FRIDGEDOOR_HTTPS=tailscale TS_AUTHKEY=tskey-auth-... bash install.sh
```

| Variable | Meaning |
|---|---|
| `FRIDGEDOOR_HTTPS` | `tailscale`, `cloudflare`, `domain` or `none` |
| `TS_AUTHKEY` | Tailscale auth key, with `tailscale` |
| `TS_FUNNEL=false` | With `tailscale`: reachable only from devices signed in to your tailnet |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token, with `cloudflare` |
| `PUBLIC_HOST` | Hostname routed to the tunnel, with `cloudflare` |
| `DOMAIN` | Domain name, with `domain` |
| `FRIDGEDOOR_DIR` | Install folder |
| `FRIDGEDOOR_YES=1` | Install Docker without asking |

`domain` is for a server with ports 80 and 443 open to the internet, usually a [VPS](vps.md).

The installer saves your choice in `.env`. When you run it again, it reuses that choice without asking. To switch to a different option, set `FRIDGEDOOR_HTTPS` when you run it, for example `curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh | FRIDGEDOOR_HTTPS=tailscale bash`.

### Lost the setup link?

Print it again from the install folder:

```sh
cd /opt/fridgedoor    # or ~/fridgedoor
docker compose exec fridgedoor fridgedoor setup-link
```

The link may start with `http://localhost:8080`. If so, keep everything from `/dashboard` onward and put your real address in front.

### Open the setup link at the address your family will use

Setup remembers the address you used to open it, and sign-in only works at that address. If you set up at `http://192.168.1.20:8080` and later switch to Tailscale, tell Fridgedoor the new address. Before you switch, an owner can do it in **Settings → Server**. After you switch, run this from the install folder:

```sh
docker compose exec fridgedoor fridgedoor public-url https://fridgedoor.your-tailnet.ts.net
docker compose restart fridgedoor
```

## Option A: Tailscale

Tailscale gives Fridgedoor a free address like `https://fridgedoor.your-tailnet.ts.net` with a real HTTPS certificate. You don't need to open any ports on your router. It also works if your internet provider doesn't give you a public IP address (CGNAT).

There are two modes:

- Funnel (public), the default. Anyone with the address can reach the Fridgedoor sign-in page, and phones don't need the Tailscale app. This is easiest for families. Funnel is still labelled beta, and its bandwidth is limited, which is enough for a household.
- Tailnet-only (private). Only devices signed in to your Tailscale network can reach Fridgedoor, so every phone and laptop needs the Tailscale app. This is the most private option. Tailscale's free Personal plan covers up to 6 users.

Steps:

1. Create a free account at <https://tailscale.com>.
2. In the admin console, open **DNS**. Make sure **MagicDNS** is on. Under **HTTPS Certificates**, click **Enable HTTPS**. This publishes your machine names (for example `fridgedoor.your-tailnet.ts.net`) in public certificate logs, so don't use names that reveal anything private.
3. Open **Settings > Keys** and click **Generate auth key**. The default settings are fine. Don't add tags to the key, or the Funnel rule in step 4 won't apply to it. Copy the key. It starts with `tskey-auth-`.
4. For Funnel only: open **Access controls**, find the **Funnel** section, and click **Add Funnel to policy**. This adds the following to your policy file:

   ```json
   "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
   ```

5. Run the installer and choose **2) tailscale**. Paste the auth key when it asks. The installer starts a Tailscale container next to Fridgedoor, which joins your tailnet as a machine named `fridgedoor`, and prints the setup link with your `ts.net` address.
6. In the admin console, open **Machines** and find `fridgedoor`. Open its **...** menu and choose **Disable key expiry**. Otherwise Tailscale signs it out after about six months and Fridgedoor goes offline.

For tailnet-only (private) mode, run the installer with `TS_FUNNEL=false`. On an existing install, you can instead add `TS_SERVE_FILE=tailscale-serve-private.json` to `.env` and run `docker compose --profile tailscale up -d --force-recreate tailscale`.

## Option B: Cloudflare Tunnel

Cloudflare Tunnel puts Fridgedoor on your own domain, like `https://fridgedoor.yourdomain.com`, without opening ports. It's free and well established. You need a domain that uses Cloudflare for DNS. Cloudflare decrypts the traffic on its servers before passing it to your home.

1. Get a domain on Cloudflare. Either buy one with Cloudflare Registrar (a `.com` is about $10-11/year), or add a domain you already own to Cloudflare and switch its nameservers.
2. In the Cloudflare dashboard, go to **Networking > Tunnels**.
3. Click **Create a tunnel**, name it `fridgedoor`, and create it.
4. When Cloudflare shows install commands, choose **Docker**. Copy only the long token after `--token`. Don't run the command: Fridgedoor's installer runs the tunnel for you.
5. Open the tunnel's **Routes** tab. Click **Add route**, then **Published application** (older dashboards call this **Public Hostname**), and fill in:
   - Subdomain: `fridgedoor`
   - Domain: your domain
   - Service URL: `http://fridgedoor:8080`

   Then save.
6. Run the installer and choose **3) cloudflare**. Paste the token, then type the hostname from step 5 (for example `fridgedoor.yourdomain.com`).

## Option C: Home network only (for trying it out)

Choose **4) none** in the installer. Fridgedoor is then available at `http://<computer's IP address>:8080`, for example `http://192.168.1.20:8080`.

The iPhone app accepts plain `http://` only for local addresses, such as `192.168.x.x`, `10.x.x.x` or `name.local`, so it won't work when you're away from home. Web notifications need HTTPS, so they won't work either.

To switch to Tailscale or Cloudflare later:

1. Run the installer again with the new option, for example `curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh | FRIDGEDOOR_HTTPS=tailscale bash`.
2. Run the [`public-url` command](#open-the-setup-link-at-the-address-your-family-will-use) to set the new address.

## Mac or Windows (Docker Desktop)

1. Install Docker Desktop and set your computer to never sleep.
2. Make a folder, for example `fridgedoor`. Download these files into it, keeping the `deploy` subfolder:
   - [`compose.yaml`](https://raw.githubusercontent.com/ravimody/fridgedoor/main/compose.yaml)
   - [`.env.example`](https://raw.githubusercontent.com/ravimody/fridgedoor/main/.env.example)
   - [`deploy/Caddyfile`](https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/Caddyfile)
   - [`deploy/tailscale-serve.json`](https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/tailscale-serve.json)
3. Copy `.env.example` to `.env`. For Tailscale, add these lines:

   ```
   TS_AUTHKEY=tskey-auth-...
   FRIDGEDOOR_BIND=127.0.0.1
   TRUST_PROXY=true
   ```

4. In a terminal in that folder, run:

   ```sh
   docker compose --profile tailscale up -d
   docker compose exec fridgedoor fridgedoor setup-link
   ```

   The link starts with `http://localhost:8080`. Replace that part with `https://fridgedoor.<your-tailnet>.ts.net` before you open it.

For Cloudflare, put `TUNNEL_TOKEN`, `PUBLIC_URL=https://fridgedoor.yourdomain.com`, `FRIDGEDOOR_BIND=127.0.0.1`, `TRUST_PROXY=true` and `CLIENT_IP_HEADER=CF-Connecting-IP` in `.env` instead, and use `--profile cloudflare`. To try it on your home network, leave `.env` as copied and run `docker compose up -d`.

## Upgrades

The simplest way to upgrade is to run the installer again. It downloads the current `compose.yaml` and starts the newest release, keeping your choices in `.env`.

`compose.yaml` pins exact versions of the Caddy, Tailscale and cloudflared images, while Fridgedoor itself uses `latest`, which changes when a new version is released. `docker compose pull` alone updates Fridgedoor but keeps the helper images at the versions your copy of `compose.yaml` names. To upgrade by hand, download the new `compose.yaml` first. From the install folder, using the same profile you installed with:

```sh
curl -fsSLO https://raw.githubusercontent.com/ravimody/fridgedoor/main/compose.yaml
docker compose --profile tailscale pull
docker compose --profile tailscale up -d
```

Use `--profile cloudflare` for a tunnel, or `--profile caddy` for a domain. If you chose home network only, leave the profile out.

## Backups

Fridgedoor keeps everything in one Docker volume. A backup has two parts: a copy of the database, and the `secret.key` file. Without `secret.key`, a restored backup can't read your saved email passwords or AI keys.

To make a backup and copy it out of Docker:

```sh
cd /opt/fridgedoor    # or ~/fridgedoor
docker compose exec fridgedoor fridgedoor backup
docker compose cp fridgedoor:/data/backups/. ./backups
docker compose cp fridgedoor:/data/secret.key ./backups/secret.key
```

Then copy the `backups` folder somewhere else: another computer, a USB drive, or cloud storage. `secret.key` is sensitive, so keep it somewhere private.

Fridgedoor also makes a copy once a day by itself and keeps the last 7, in `/data/backups`. To copy those off the machine every night at 3:30 a.m., run `crontab -e` (or `sudo crontab -e` if Docker needs `sudo`) and add this line, with your install folder:

```
30 3 * * * cd /opt/fridgedoor && docker compose cp fridgedoor:/data/backups/. ./backups > /dev/null
```

To restore, stop Fridgedoor, put the backup file and `secret.key` back into the volume, and start Fridgedoor again. Replace `fridgedoor-2026-10-11.sqlite` with your backup's file name:

```sh
docker compose stop fridgedoor
docker run --rm -v fridgedoor_fridgedoor-data:/data -v "$PWD/backups":/restore debian:bookworm-slim \
  sh -c 'rm -f /data/fridgedoor.sqlite-wal /data/fridgedoor.sqlite-shm && cp /restore/fridgedoor-2026-10-11.sqlite /data/fridgedoor.sqlite && cp /restore/secret.key /data/secret.key'
docker compose start fridgedoor
```

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Put Fridgedoor on your phones](../iphone.md)
- Back to [choosing a host](README.md)
