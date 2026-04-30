#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# litestream_start.sh
#
# 1. Renders /etc/msmtprc from SMTP_* env vars
# 2. Attempts to restore the denokv database from the S3 replica if the DB
#    does not already exist on the volume (first boot or volume replacement)
# 3. Starts litestream replicate (continuous replication going forward)
# ---------------------------------------------------------------------------
set -euo pipefail

DB_PATH="/data/denokv.sqlite"
LS_CONFIG="/etc/litestream/litestream.yml"

echo "[litestream_start] Starting…"

# ---- Render msmtprc from environment ------------------------------------
cat > /etc/msmtprc <<MSMTP
defaults
  auth           on
  tls            on
  tls_starttls   on
  tls_trust_file /etc/ssl/certs/ca-certificates.crt
  logfile        /dev/stderr

account        default
  host           ${SMTP_HOST}
  port           ${SMTP_PORT:-587}
  from           ${SMTP_FROM}
  user           ${SMTP_USER}
  password       ${SMTP_PASSWORD}

account default : default
MSMTP
chmod 600 /etc/msmtprc
echo "[litestream_start] msmtprc rendered"

# ---- Restore if the DB is missing (cold start) --------------------------
if [ ! -f "${DB_PATH}" ]; then
  echo "[litestream_start] No database found at ${DB_PATH} – attempting restore from S3…"
  if litestream restore -config "${LS_CONFIG}" -if-replica-exists "${DB_PATH}"; then
    echo "[litestream_start] Restore succeeded."
  else
    echo "[litestream_start] No replica found or restore failed – starting with fresh database."
  fi
else
  echo "[litestream_start] Existing database found at ${DB_PATH} – skipping restore."
fi

# ---- Start continuous replication ----------------------------------------
echo "[litestream_start] Starting litestream replicate…"
exec litestream replicate -config "${LS_CONFIG}"
