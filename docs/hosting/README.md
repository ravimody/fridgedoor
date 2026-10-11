# Hosting Fridgedoor: how to choose

Fridgedoor runs on a computer you control: a machine at home, a NAS, a small cloud server, or an app platform. This page helps you pick one. Every option uses the same Docker image, `ghcr.io/ravimody/fridgedoor:latest`. It runs on both Intel/AMD (amd64) and Arm (arm64) machines.

## What Fridgedoor needs

Whatever you pick must give Fridgedoor all four of these:

1. **Always on.** Fridgedoor reads your email every few minutes and sends reminders. Services that sleep or "scale to zero" when nobody is using them won't work.
2. **A disk that survives restarts,** mounted at `/data`. It holds the database and the encryption key (`secret.key`).
3. **HTTPS on a real address,** such as `https://fridgedoor.example.com` or `https://fridgedoor.your-tailnet.ts.net`. The iPhone app needs it. See [HTTPS explained](https.md).
4. **About 250 MB of memory.** Fridgedoor itself uses about 150-250 MB. On a virtual machine, pick one with at least 1 GB.

## The options

Prices as of October 2026. They change often, so check the provider's page before you sign up.

| Option | Monthly cost | Difficulty | HTTPS | Best for |
|---|---|---|---|---|
| [Computer at home](home-server.md) + Tailscale | $0 (electricity) | Easy-medium | Tailscale gives a free `*.ts.net` address. No ports to open. | Free and private |
| [Computer at home](home-server.md) + Cloudflare Tunnel | $0, plus a domain (about $10/year) | Medium | Your own domain through Cloudflare. No ports to open. | A permanent address for a home server |
| [NAS](nas.md) (Synology, Unraid, TrueNAS) | $0 | Easy-medium | Tailscale or Cloudflare Tunnel | People who already own a NAS |
| [Oracle Cloud Always Free](vps.md#oracle-cloud-always-free) | $0 | Hard | Caddy with a domain or DuckDNS, or Tailscale | Free cloud hosting, if you're patient |
| [Google Cloud e2-micro](vps.md#google-cloud-e2-micro) | $0 for the server, but about $3.65 for its IP address | Medium | Caddy with a domain or DuckDNS, or Tailscale | Almost-free cloud hosting |
| [Railway](railway.md) | About $5 | Easiest | Automatic (`*.up.railway.app`) | Simplest paid option |
| [Fly.io](fly.md) | About $4 | Easy (command line) | Automatic (`*.fly.dev`) | Lowest-cost managed option, AI agents |
| [Render](render.md) | About $7.25 | Easy | Automatic (`*.onrender.com`) | People who prefer clicking to typing |
| [Cheap VPS](vps.md) (Vultr, Linode, OVH, DigitalOcean, Lightsail) | About $5-7 | Medium | Caddy with a domain or DuckDNS, or Tailscale | Full control at a low price |

## Our recommendation

- **Free, at home:** an always-on computer, Raspberry Pi 5 or NAS with [Tailscale](home-server.md#option-a-tailscale).
- **Free, in the cloud:** [Oracle Cloud Always Free](vps.md#oracle-cloud-always-free). Be ready for "out of capacity" errors, and know that Oracle can reclaim idle machines. A simpler alternative is [Google Cloud e2-micro](vps.md#google-cloud-e2-micro). The server is free, but its public IP address costs about $3.65/month.
- **Simplest paid:** [Railway](railway.md) (about $5/month) or [Fly.io](fly.md) (about $4/month). They handle HTTPS for you.
- **Cheap VPS:** [Vultr, Linode or OVH](vps.md) for about $5/month. You get a whole Linux server.

If you're using an AI coding agent (Claude Code, Codex), Fly.io and Railway are the easiest choices. Everything can be done from their command-line tools. A VPS with [`deploy/cloud-init.yaml`](vps.md#2-install-fridgedoor) is just as scriptable.

## What doesn't work (and why)

- **Render's free tier.** Free services go to sleep after 15 minutes and can't have a disk. Fridgedoor would stop reading email and would lose its data. Render works on a [paid instance](render.md).
- **DigitalOcean App Platform.** It has no persistent disks, so the database would be wiped on every deploy. A DigitalOcean [Droplet](vps.md#digitalocean) works fine.
- **AWS and Azure "free tiers".** These are now time-limited credits, not free servers. New AWS accounts get credits for up to 6 months. Azure's free VMs last 12 months, and only if you upgrade to pay-as-you-go within 30 days. You can use them, but expect to start paying later.
- **Serverless and scale-to-zero platforms** (for example Koyeb's free tier, Google Cloud Run, Vercel). They stop the app when nobody is visiting, so the background worker stops too.
- **sslip.io, nip.io and `trycloudflare.com` addresses.** sslip.io and nip.io names often fail to get certificates because Let's Encrypt rate-limits those whole domains. Quick tunnels on `trycloudflare.com` get a new random address every time they restart. Use a real domain, [DuckDNS](vps.md#free-domain-name-with-duckdns), Tailscale, or your platform's built-in address instead.

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
- [Install the iPhone app](../iphone.md)
