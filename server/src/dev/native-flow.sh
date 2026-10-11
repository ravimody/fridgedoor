#!/usr/bin/env bash
# Signs in to a running native preview server (pnpm dev:native) with the same
# PKCE handoff the iOS app uses, then prints a native access token on stdout.
#   TOKEN=$(src/dev/native-flow.sh)
#   curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8899/native/v1/plans
# Synthetic preview only: Access is simulated, so no credentials are involved.
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT:-8899}}"
REDIRECT_URI='fridgedoor://auth/callback'

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
verifier=$(openssl rand 48 | b64url | cut -c1-64)
challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | b64url)
state=$(openssl rand -hex 16)
query="code_challenge=${challenge}&code_challenge_method=S256&state=${state}&redirect_uri=fridgedoor%3A%2F%2Fauth%2Fcallback"

page_status=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/dashboard/native/authorize?${query}")
[ "$page_status" = 200 ] || { echo "authorize page returned HTTP ${page_status}" >&2; exit 1; }
echo "1/3 confirmation page OK" >&2

location=$(curl -s -o /dev/null -D - -X POST "${BASE_URL}/dashboard/native/authorize" \
  -H "Origin: ${BASE_URL}" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data "${query}" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
case "$location" in "${REDIRECT_URI}"*) ;; *) echo "unexpected redirect: ${location:-<none>}" >&2; exit 1 ;; esac
code=$(printf '%s' "$location" | sed -E 's/.*[?&]code=([^&]+).*/\1/')
returned_state=$(printf '%s' "$location" | sed -E 's/.*[?&]state=([^&]+).*/\1/')
[ "$returned_state" = "$state" ] || { echo "state mismatch" >&2; exit 1; }
echo "2/3 received one-time code" >&2

tokens=$(curl -s -X POST "${BASE_URL}/native/v1/auth/token" -H 'Content-Type: application/json' \
  --data "{\"grantType\":\"authorization_code\",\"code\":\"${code}\",\"codeVerifier\":\"${verifier}\",\"deviceLabel\":\"native-flow.sh\"}")
access=$(printf '%s' "$tokens" | sed -nE 's/.*"accessToken":"([^"]+)".*/\1/p')
refresh=$(printf '%s' "$tokens" | sed -nE 's/.*"refreshToken":"([^"]+)".*/\1/p')
[ -n "$access" ] || { echo "token exchange failed: ${tokens}" >&2; exit 1; }
echo "3/3 signed in; refresh token: ${refresh}" >&2

printf '%s\n' "$access"
