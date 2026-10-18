#!/bin/sh
# Runs Fridgedoor as the unprivileged `node` user. When started as root (the default),
# first make sure the data directory belongs to that user, which matters for bind mounts.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || echo "fridgedoor: could not change ownership of ${DATA_DIR:-/data}; make sure uid 1000 can write to it" >&2
  exec su-exec node "$@"
fi
exec "$@"
