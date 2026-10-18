# Choosing where to host Fridgedoor

For most households, the best choice is an always-on computer or NAS at home with Tailscale, which is free. If you'd rather pay a few dollars a month and not run hardware, use Railway or Fly.io. Every option runs the same Docker image, `ghcr.io/ravimody/fridgedoor:latest`, on Intel/AMD (amd64) or Arm (arm64) machines. `latest` is the newest release; to upgrade, pull it again after a release. Testers can use `:main`, which follows the main branch.

## What Fridgedoor needs

Whatever you pick must provide all of these:

1. Always on. Fridgedoor reads your email every few minutes and sends reminders. Services that sleep or "scale to zero" when nobody is using them won't work.
2. A disk that survives restarts, mounted at `/data`. It holds the database and the encryption key (`secret.key`).
3. HTTPS on a stable address, such as `https://fridgedoor.example.com` or `https://fridgedoor.your-tailnet.ts.net`. Phones need it for notifications and for the iPhone app. See [HTTPS explained](https.md).
4. About 250 MB of memory. Fridgedoor itself uses about 150-250 MB. On a virtual machine, pick one with at least 1 GB.

## The options

Prices as of October 2026. They change often, so check the provider's page before you sign up.

| Option | Monthly cost | Difficulty | HTTPS | Best for |
|---|---|---|---|---|
| [Computer at home](home-server.md) + Tailscale | $0 (electricity) | Easy-medium | Tailscale gives a free `*.ts.net` address. No ports to open. | Free and private |
| [Computer at home](home-server.md) + Cloudflare Tunnel | $0, plus a domain (about $10/year) | Medium | Your own domain through Cloudflare. No ports to open. | A permanent address for a home server |
| [NAS](nas.md) (Synology, Unraid, TrueNAS) | $0 | Easy-medium | Tailscale or Cloudflare Tunnel | People who already own a NAS |
| [Oracle Cloud Always Free](vps.md#oracle-cloud-always-free) | $0 | Hard | Caddy with a domain or DuckDNS, or Tailscale | Free cloud hosting, if you're patient |
| [Google Cloud e2-micro](vps.md#google-cloud-e2-micro) | $0 for the server, about $3.65 for its IP address | Medium | Caddy with a domain or DuckDNS, or Tailscale | Almost-free cloud hosting |
| [Railway](railway.md) | About $5 | Easiest | Automatic (`*.up.railway.app`) | Simplest paid option |
| [Fly.io](fly.md) | About $4 | Easy (command line) | Automatic (`*.fly.dev`) | Lowest-cost managed option, AI agents |
| [Render](render.md) | About $7.25 | Easy | Automatic (`*.onrender.com`) | People who prefer clicking to typing |
| [Cheap VPS](vps.md) (Vultr, Linode, OVH, DigitalOcean, Lightsail) | About $5-7 | Medium | Caddy with a domain or DuckDNS, or Tailscale | Full control at a low price |

## Our recommendation

- Free, at home: an always-on computer, Raspberry Pi 5 or NAS with [Tailscale](home-server.md#option-a-tailscale).
- Free, in the cloud: [Oracle Cloud Always Free](vps.md#oracle-cloud-always-free). Expect "out of capacity" errors when you create the server, and note that Oracle can reclaim idle machines. [Google Cloud e2-micro](vps.md#google-cloud-e2-micro) is easier to get. The server is free, but its public IP address costs about $3.65/month.
- Simplest paid: [Railway](railway.md) (about $5/month) or [Fly.io](fly.md) (about $4/month). Both handle HTTPS for you.
- Cheap VPS: [Vultr, Linode or OVH](vps.md) for about $5/month. You get a whole Linux server.

If an AI coding agent (Claude Code, Codex) is doing the setup, Fly.io and Railway are the easiest choices, because every step can be done with their command-line tools. A VPS created with [`deploy/cloud-init.yaml`](vps.md#2-install-fridgedoor) is just as scriptable. See also [setting up Fridgedoor with an AI coding agent](../setup-with-an-ai-agent.md).

## What doesn't work

- Render's free tier. Free services go to sleep after 15 minutes and can't have a disk, so Fridgedoor would stop reading email and lose its data. Render works on a [paid instance](render.md).
- DigitalOcean App Platform. It has no persistent disks, so the database would be wiped on every deploy. A DigitalOcean [Droplet](vps.md#digitalocean) works.
- AWS and Azure "free tiers". These are now time-limited credits, not free servers. New AWS accounts get credits for up to 6 months. Azure's free VMs last 12 months, and only if you upgrade to pay-as-you-go within 30 days. You can use them, but expect to start paying later.
- Serverless and scale-to-zero platforms, for example Koyeb's free tier, Google Cloud Run and Vercel. They stop the app when nobody is visiting, which also stops the background worker.
- sslip.io, nip.io and `trycloudflare.com` addresses. Every sslip.io or nip.io name shares one Let's Encrypt rate limit with everyone else using the service, so getting or renewing a certificate can fail. Quick tunnels on `trycloudflare.com` get a new random address every time they restart. Use a real domain, [DuckDNS](vps.md#free-domain-name-with-duckdns), Tailscale, or your platform's built-in address instead.

## All hosting pages

- [Computer at home](home-server.md): old PC, Mac mini, Raspberry Pi 5, or any always-on Linux machine
- [NAS](nas.md): Synology, Unraid, TrueNAS SCALE
- [VPS and cloud VMs](vps.md): Oracle, Google Cloud, AWS, DigitalOcean, Vultr, Linode, OVH, Hetzner
- [Fly.io](fly.md)
- [Railway](railway.md)
- [Render](render.md)
- [HTTPS explained](https.md)

## Next steps

Once Fridgedoor is running and you've opened the setup link:

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Put Fridgedoor on your phones](../iphone.md): add the web app to the home screen, or build the iPhone app yourself
