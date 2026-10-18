# HTTPS explained

Fridgedoor needs an `https://` address with a certificate that phones trust. At home, Tailscale is the simplest way to get one. On a VPS, use Caddy with a domain. On Fly.io, Railway and Render it's built in.

HTTPS is the padlock in your browser's address bar. It means the connection is encrypted, and that a trusted authority has confirmed the address belongs to the server you're talking to.

## Why Fridgedoor needs it

- The iPhone app requires it. iOS lets apps use plain `http://` only for addresses on your local network, such as `192.168.1.20` or `name.local`. Anywhere else, the app needs `https://` with a real certificate. A self-signed certificate (one you make yourself) isn't trusted, so it doesn't work.
- Passwords and family data cross the internet. Without HTTPS, anyone on the same Wi-Fi or along the route could read them.
- Browser features need it. Web notifications, including on a phone that added Fridgedoor to its home screen, only work over HTTPS. Connecting Gmail or Google Calendar also needs an HTTPS address for Google to return to.

## Your options

| Option | Cost | Your address | Opens ports? | Notes |
|---|---|---|---|---|
| Built into [Fly.io](fly.md), [Railway](railway.md), [Render](render.md) | Included | `*.fly.dev`, `*.up.railway.app`, `*.onrender.com` | No | Nothing to set up. You can add your own domain later. |
| [Tailscale Funnel](home-server.md#option-a-tailscale) | Free | `fridgedoor.<tailnet>.ts.net` | No | Best free choice at home. Works without a public IP address. Phones don't need Tailscale. Still labelled beta, with limited bandwidth. |
| [Tailscale, tailnet-only](home-server.md#option-a-tailscale) | Free | `fridgedoor.<tailnet>.ts.net` | No | Most private: only your own devices running Tailscale can connect. |
| [Cloudflare Tunnel](home-server.md#option-b-cloudflare-tunnel) | Free, plus a domain (about $10/year) | `fridgedoor.yourdomain.com` | No | Stable and mature. Cloudflare can see the traffic. |
| [Caddy with your domain](vps.md#3-point-a-domain-name-at-the-vm) | A domain (about $10/year) | `fridgedoor.yourdomain.com` | Yes, 80 and 443 | The usual choice on a VPS. Caddy gets and renews Let's Encrypt certificates by itself. |
| [Caddy with DuckDNS](vps.md#free-domain-name-with-duckdns) | Free | `yourname.duckdns.org` | Yes, 80 and 443 | Free domain name. Run by volunteers, with occasional outages. |
| Home network only | Free | `http://192.168.x.x:8080` | No | Only for trying it out. The iPhone app works only at home, and web notifications don't work. |

Prices as of October 2026.

The installer (`FRIDGEDOOR_HTTPS`) and `compose.yaml` use these names for the options:

| Installer choice | `compose.yaml` profile |
|---|---|
| `tailscale` | `tailscale` |
| `cloudflare` | `cloudflare` |
| `domain` | `caddy` |
| `none` | none |

## Behind a proxy: two settings

With every option except "home network only", visitors reach Fridgedoor through a proxy (Caddy, Tailscale, cloudflared, or the platform's own). Fridgedoor then needs `TRUST_PROXY=true`, so its sign-in rate limits count each visitor separately. Without it, every visitor looks like the proxy, and one person's wrong passwords can lock everyone out of sign-in for a while.

With `TRUST_PROXY=true`, Fridgedoor reads the visitor's address from the header named in `CLIENT_IP_HEADER`, or, if that's unset, from the right-most address in `X-Forwarded-For`:

| Setup | `CLIENT_IP_HEADER` | Who sets it |
|---|---|---|
| Caddy (`domain`) or Tailscale | leave unset | The installer sets `TRUST_PROXY=true`. |
| Cloudflare Tunnel | `CF-Connecting-IP` | The installer sets both. |
| Fly.io | `Fly-Client-IP` | `fly.toml` sets both. |
| Render | `CF-Connecting-IP` | `render.yaml` sets both. |
| Railway | `X-Real-IP` | You do, as described in the [Railway guide](railway.md). |

On your own server with Docker Compose, also set `FRIDGEDOOR_BIND=127.0.0.1`, so plain HTTP on port 8080 isn't reachable from outside. Ports that Docker publishes bypass firewalls such as `ufw`. The installer sets this for `domain`, `tailscale` and `cloudflare`. If you write `.env` yourself, add these lines.

## What to avoid

- sslip.io and nip.io. These turn an IP address into a name, like `1-2-3-4.nip.io`. Let's Encrypt limits how many certificates each domain can get, and on these services everyone shares the same limit, so getting or renewing a certificate can fail.
- Cloudflare quick tunnels (`*.trycloudflare.com`). Every restart gives you a new random address, so your family's phones lose the connection. They're meant for quick demos.
- Self-signed certificates. Phones and browsers don't trust them.

## Changing your address later

If you move to a new address (for example from Tailscale to your own domain), tell Fridgedoor in one of these ways:

- In the web app, an owner opens **Settings → Server** and enters the new address. This takes effect straight away.
- Set `PUBLIC_URL=https://new.address` in Fridgedoor's settings (`.env` on a server, or the environment variables or secrets on a platform), then restart. While `PUBLIC_URL` is set, it overrides the address in Settings.
- On a server with Docker Compose, from the install folder:

  ```sh
  docker compose exec fridgedoor fridgedoor public-url https://new.address
  docker compose restart fridgedoor
  ```

A home-screen icon keeps opening the old address, so on each phone delete it, open the new address in Safari, and choose Share → Add to Home Screen again. Anyone using the iPhone app may need to enter the new address in it.

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Put Fridgedoor on your phones](../iphone.md)
- Back to [choosing a host](README.md)
