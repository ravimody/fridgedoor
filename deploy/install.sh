#!/usr/bin/env bash
# Fridgedoor installer for a Linux server (a VPS, a home server, a Raspberry Pi).
#
#   curl -fsSL https://raw.githubusercontent.com/ravimody/fridgedoor/main/deploy/install.sh | bash
#
# It installs Docker if needed, writes compose.yaml and .env into $FRIDGEDOOR_DIR,
# starts Fridgedoor, and prints the one-time setup link. Re-running it upgrades.
#
# Everything it asks can be answered ahead of time (for scripts and AI agents):
#   FRIDGEDOOR_DIR      install directory (default /opt/fridgedoor, or ~/fridgedoor without root)
#   FRIDGEDOOR_HTTPS    domain | tailscale | cloudflare | none
#   DOMAIN              with "domain": a DNS name already pointing at this server
#   TS_AUTHKEY          with "tailscale": a Tailscale auth key
#   TS_FUNNEL=false     with "tailscale": reachable only from devices signed in to your tailnet
#   TUNNEL_TOKEN        with "cloudflare": a Cloudflare Tunnel token
#   PUBLIC_HOST         with "cloudflare": the hostname you routed to the tunnel
#   FRIDGEDOOR_YES=1    don't ask before installing Docker
#   FRIDGEDOOR_REF      git branch or tag to download files from (default main)
set -euo pipefail
# Secrets (.env) and logs created here are readable only by their owner.
umask 077

REPO_RAW="https://raw.githubusercontent.com/ravimody/fridgedoor/${FRIDGEDOOR_REF:-main}"
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'fridgedoor: %s\n' "$*" >&2; exit 1; }
# Prompts read from the terminal even when this script is piped into bash.
ask() { local prompt=$1 var=$2 secret=${3:-}; if [ -n "${!var:-}" ]; then return; fi; [ -r /dev/tty ] || die "$var is required when running without a terminal"; if [ -n "$secret" ]; then read -r -s -p "$prompt" "$var" </dev/tty; echo; else read -r -p "$prompt" "$var" </dev/tty; fi; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then command -v sudo >/dev/null && SUDO="sudo"; fi
DIR=${FRIDGEDOOR_DIR:-$([ "$(id -u)" -eq 0 ] && echo /opt/fridgedoor || echo "$HOME/fridgedoor")}

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Docker isn't installed."
  if [ "${FRIDGEDOOR_YES:-}" != "1" ]; then ask "Install Docker now with Docker's official script (get.docker.com)? [y/N] " REPLY_DOCKER; [[ "${REPLY_DOCKER:-}" =~ ^[Yy] ]] || die "Install Docker, then run this again."; fi
  curl -fsSL https://get.docker.com | $SUDO sh
fi
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"; $DOCKER info >/dev/null 2>&1 || die "Can't talk to Docker. Is it running?"; fi
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)."

# 2. Files
# Only ask for sudo when the folder can't be created as this user (for example /opt).
if ! mkdir -p "$DIR/deploy" 2>/dev/null; then $SUDO mkdir -p "$DIR/deploy" && $SUDO chown "$(id -u):$(id -g)" "$DIR" "$DIR/deploy"; fi
cd "$DIR"
for file in compose.yaml .env.example deploy/Caddyfile deploy/tailscale-serve.json deploy/tailscale-serve-private.json; do curl -fsSL "$REPO_RAW/$file" -o "$file"; done

# 3. HTTPS
if [ -z "${FRIDGEDOOR_HTTPS:-}" ] && [ -f .env ] && grep -q '^FRIDGEDOOR_HTTPS=' .env; then FRIDGEDOOR_HTTPS=$(grep '^FRIDGEDOOR_HTTPS=' .env | cut -d= -f2-); fi
if [ -z "${FRIDGEDOOR_HTTPS:-}" ]; then
  cat <<'EOF'

How should phones reach Fridgedoor over HTTPS?
  1) domain      I have a domain name pointing at this server (automatic certificates)
  2) tailscale   Use Tailscale (free; works at home without opening ports)
  3) cloudflare  Use a Cloudflare Tunnel (needs a domain on Cloudflare)
  4) none        Plain HTTP on this network only (fine for trying it out)
EOF
  ask "Choose 1-4: " CHOICE
  case "${CHOICE:-}" in 1|domain) FRIDGEDOOR_HTTPS=domain;; 2|tailscale) FRIDGEDOOR_HTTPS=tailscale;; 3|cloudflare) FRIDGEDOOR_HTTPS=cloudflare;; *) FRIDGEDOOR_HTTPS=none;; esac
fi

touch .env
set_env() { if grep -q "^$1=" .env; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
unset_env() { for key in "$@"; do if grep -q "^$key=" .env; then sed -i.bak "/^$key=/d" .env && rm -f .env.bak; fi; done; }
# Switching modes: forget the address and proxy settings from the previous choice, but
# reuse a previous domain or hostname when the same mode runs again (upgrades).
previous() { grep "^$1=" .env | cut -d= -f2- || true; }
PREVIOUS_MODE=$(previous FRIDGEDOOR_HTTPS)
if [ "$PREVIOUS_MODE" = "$FRIDGEDOOR_HTTPS" ]; then
  DOMAIN=${DOMAIN:-$(previous DOMAIN)}
  PREVIOUS_URL=$(previous PUBLIC_URL); PUBLIC_HOST=${PUBLIC_HOST:-${PREVIOUS_URL#https://}}
  [ "$FRIDGEDOOR_HTTPS" = "tailscale" ] && [ "$(previous TS_SERVE_FILE)" = "tailscale-serve-private.json" ] && TS_FUNNEL=${TS_FUNNEL:-false}
fi
unset_env PUBLIC_URL DOMAIN FRIDGEDOOR_BIND TRUST_PROXY TS_SERVE_FILE
set_env FRIDGEDOOR_HTTPS "$FRIDGEDOOR_HTTPS"
PROFILE=()
case "$FRIDGEDOOR_HTTPS" in
  domain) ask "Domain name (e.g. fridgedoor.example.com): " DOMAIN; set_env DOMAIN "$DOMAIN"; set_env PUBLIC_URL "https://$DOMAIN"; set_env FRIDGEDOOR_BIND 127.0.0.1; set_env TRUST_PROXY true; PROFILE=(--profile caddy); BASE="https://$DOMAIN";;
  tailscale) grep -q '^TS_AUTHKEY=' .env || { ask "Tailscale auth key (input hidden): " TS_AUTHKEY secret; set_env TS_AUTHKEY "$TS_AUTHKEY"; }; [ "${TS_FUNNEL:-true}" = "false" ] && set_env TS_SERVE_FILE tailscale-serve-private.json; set_env FRIDGEDOOR_BIND 127.0.0.1; set_env TRUST_PROXY true; PROFILE=(--profile tailscale);;
  cloudflare) grep -q '^TUNNEL_TOKEN=' .env || { ask "Cloudflare Tunnel token (input hidden): " TUNNEL_TOKEN secret; set_env TUNNEL_TOKEN "$TUNNEL_TOKEN"; }; ask "Public hostname routed to the tunnel (e.g. fridgedoor.example.com): " PUBLIC_HOST; set_env PUBLIC_URL "https://$PUBLIC_HOST"; set_env FRIDGEDOOR_BIND 127.0.0.1; set_env TRUST_PROXY true; PROFILE=(--profile cloudflare); BASE="https://$PUBLIC_HOST";;
  none) BASE="http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost):$(previous FRIDGEDOOR_PORT | grep . || echo 8080)";;
  *) die "FRIDGEDOOR_HTTPS must be domain, tailscale, cloudflare or none";;
esac
chmod 600 .env

# 4. Start
say "Starting Fridgedoor in $DIR ..."
$DOCKER compose ${PROFILE[@]+"${PROFILE[@]}"} pull --quiet </dev/null
$DOCKER compose ${PROFILE[@]+"${PROFILE[@]}"} up -d </dev/null
for _ in $(seq 1 60); do
  if $DOCKER compose exec -T fridgedoor node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" </dev/null >/dev/null 2>&1; then break; fi
  sleep 2
done
if [ "$FRIDGEDOOR_HTTPS" = "tailscale" ]; then
  for _ in $(seq 1 30); do HOSTNAME_TS=$($DOCKER compose exec -T tailscale tailscale status --json </dev/null 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1); [ -n "${HOSTNAME_TS:-}" ] && break; sleep 2; done
  [ -n "${HOSTNAME_TS:-}" ] || die "Tailscale didn't come up; check 'docker compose logs tailscale'."
  BASE="https://$HOSTNAME_TS"
fi

LINK=$($DOCKER compose exec -T fridgedoor fridgedoor setup-link </dev/null)
case "$LINK" in
  http*/dashboard/setup*) say "Fridgedoor is running. Finish setup in your browser:"; echo; echo "  ${BASE}/dashboard/setup${LINK#*/dashboard/setup}"; echo;;
  *) say "Fridgedoor is running."; echo "$LINK";;
esac
cat <<EOF
Manage it from $DIR:
  docker compose logs -f fridgedoor      # logs
  docker compose pull && docker compose ${PROFILE[*]-} up -d   # upgrade
  docker compose exec fridgedoor fridgedoor backup   # back up now
EOF
[ "$FRIDGEDOOR_HTTPS" = "tailscale" ] && echo "Tailscale: turn on HTTPS certificates and Funnel for this machine in the admin console if phones without Tailscale need access (https://github.com/ravimody/fridgedoor/blob/main/docs/hosting/home-server.md)."
exit 0
