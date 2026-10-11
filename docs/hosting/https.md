# HTTPS explained

HTTPS is the padlock in your browser's address bar. It means the connection is encrypted, and that a trusted authority has confirmed the address really belongs to the server you're talking to.

## Why Fridgedoor needs it

- **The iPhone app requires it.** iOS only lets apps use plain `http://` for addresses on your local network, such as `192.168.1.20` or `name.local`. Anywhere else, the app needs `https://` with a real certificate. A self-signed certificate (one you make yourself) isn't trusted, so it doesn't work.
- **Passwords and family data cross the internet.** Without HTTPS, anyone on the same Wi-Fi or along the route could read them.
- **Browser features need it.** Web notifications and secure sign-in cookies only work over HTTPS. Google sign-in, if you set it up, also needs an HTTPS address to return to.

## Your options

| Option | Cost | Your address | Opens ports? | Notes |
|---|---|---|---|---|
| Built into [Fly.io](fly.md), [Railway](railway.md), [Render](render.md) | Included | `*.fly.dev`, `*.up.railway.app`, `*.onrender.com` | No | Nothing to set up. You can add your own domain later. |
| [Tailscale Funnel](home-server.md#option-a-tailscale) | Free | `fridgedoor.<tailnet>.ts.net` | No | Best free choice at home. Works without a public IP address. Phones don't need Tailscale. Still labelled beta, with limited bandwidth. |
| [Tailscale, tailnet-only](home-server.md#option-a-tailscale) | Free | `fridgedoor.<tailnet>.ts.net` | No | Most private: only your own devices running Tailscale can connect. |
| [Cloudflare Tunnel](home-server.md#option-b-cloudflare-tunnel) | Free, plus a domain (about $10/year) | `fridgedoor.yourdomain.com` | No | Stable and mature. Cloudflare can see the traffic. |
| [Caddy with your domain](vps.md#3-point-a-domain-name-at-the-vm) | A domain (about $10/year) | `fridgedoor.yourdomain.com` | Yes, 80 and 443 | The usual choice on a VPS. Caddy gets and renews Let's Encrypt certificates on its own. |
| [Caddy with DuckDNS](vps.md#free-domain-name-with-duckdns) | Free | `yourname.duckdns.org` | Yes, 80 and 443 | Free domain name. Run by volunteers, with occasional outages. |
| Home network only | Free | `http://192.168.x.x:8080` | No | Only for trying it out. The iPhone app works only at home, and web notifications don't work. |

Prices as of October 2026.

In the installer and `compose.yaml`, these options are called:

- `tailscale` (profile `tailscale`)
- `cloudflare` (profile `cloudflare`)
- `domain` (profile `caddy`)
- `none`

## What to avoid

- **sslip.io and nip.io.** These turn an IP address into a name, like `1-2-3-4.sslip.io`. Let's Encrypt limits how many certificates each domain can get, and on these services everyone shares the same limit. Getting a certificate often fails.
- **Cloudflare quick tunnels (`*.trycloudflare.com`).** Every restart gives you a new random address, so your family's apps lose the connection. They're meant for quick demos.
- **Self-signed certificates.** Phones and browsers don't trust them.

## Changing your address later

If you move to a new address (for example from Tailscale to your own domain), tell Fridgedoor. Change it in **Settings → Server**, set `PUBLIC_URL=https://new.address` in its settings (`.env` on a server, or environment variables or secrets on a platform), or run this and restart:

```sh
fridgedoor public-url https://new.address
```

Anyone using the iPhone app may then need to enter the new address in it.

## Next steps

- [Choose an AI provider](../ai-providers.md)
- [Connect your email](../email.md)
- [Install the iPhone app](../iphone.md)
- Back to [choosing a host](README.md)
