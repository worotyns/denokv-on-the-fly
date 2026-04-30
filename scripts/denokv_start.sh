#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# denokv_start.sh
#
# Waits until the database file exists (litestream may still be restoring),
# then starts the denokv server.
#
# Required env vars (set as Fly secrets):
#   DENO_KV_ACCESS_TOKEN  – bearer token clients must supply
# Optional:
#   DENOKV_ADDR           – bind address (default 0.0.0.0:4512)
# ---------------------------------------------------------------------------
set -euo pipefail

DB_PATH="/data/denokv.sqlite"
ADDR="${DENOKV_ADDR:-127.0.0.1:4513}"
MAX_WAIT=60   # seconds to wait for litestream to restore

echo "[denokv_start] Waiting for database at ${DB_PATH}…"
waited=0
until [ -f "${DB_PATH}" ] || [ "$waited" -ge "$MAX_WAIT" ]; do
  sleep 1
  waited=$((waited + 1))
done

if [ ! -f "${DB_PATH}" ]; then
  echo "[denokv_start] WARNING: database not found after ${MAX_WAIT}s – starting with empty DB."
fi

echo "[denokv_start] Starting denokv serve on ${ADDR}…"
exec denokv \
  --sqlite-path "${DB_PATH}" \
  serve \
  --addr "${ADDR}" \
  --access-token "${DENO_KV_ACCESS_TOKEN}"
