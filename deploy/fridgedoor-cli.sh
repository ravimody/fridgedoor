#!/bin/sh
# `fridgedoor <command>` inside the container, e.g. `docker compose exec fridgedoor fridgedoor setup-link`.
cd /app/server
if [ "$(id -u)" = "0" ]; then exec su-exec node node dist/cli.js "$@"; fi
exec node dist/cli.js "$@"
