#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check_backup.sh   (runs daily via supercronic)
#
# Workflow:
#   1. Restore the latest S3 replica into a temp directory
#   2. Run `sqlite3 PRAGMA integrity_check` on the restored file
#   3. Send an e-mail report (pass or fail) via msmtp
#
# Required env vars (Fly secrets):
#   AWS_ACCESS_KEY_ID           – auto-set by flyctl storage create (Tigris)
#   AWS_SECRET_ACCESS_KEY       – auto-set by flyctl storage create (Tigris)
#   S3_BUCKET / S3_PATH
#   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM
#   ALERT_EMAIL   – recipient address for the report
# ---------------------------------------------------------------------------
set -euo pipefail

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
TMPDIR="/tmp/backup-check/${TIMESTAMP}"
RESTORED_DB="${TMPDIR}/denokv_check.sqlite"
LS_CONFIG="/etc/litestream/litestream.yml"
HOSTNAME="${FLY_APP_NAME:-denokv-on-the-fly}"

mkdir -p "${TMPDIR}"
trap 'rm -rf "${TMPDIR}"' EXIT

# ---- 1. Restore snapshot into temp dir ------------------------------------
echo "[check_backup] ${TIMESTAMP} – restoring replica for integrity check…"
RESTORE_OK=true
if ! litestream restore \
        -config "${LS_CONFIG}" \
        -o "${RESTORED_DB}" \
        /data/denokv.sqlite 2>&1; then
  RESTORE_OK=false
fi

# ---- 2. Integrity check ---------------------------------------------------
INTEGRITY_OK=false
INTEGRITY_OUTPUT=""
if [ "${RESTORE_OK}" = "true" ] && [ -f "${RESTORED_DB}" ]; then
  INTEGRITY_OUTPUT=$(sqlite3 "${RESTORED_DB}" "PRAGMA integrity_check;" 2>&1 || true)
  if echo "${INTEGRITY_OUTPUT}" | grep -q "^ok$"; then
    INTEGRITY_OK=true
  fi
fi

# ---- 3. Compose and send e-mail -------------------------------------------
if [ "${INTEGRITY_OK}" = "true" ]; then
  SUBJECT="✅ [${HOSTNAME}] Daily backup check PASSED – ${TIMESTAMP}"
  BODY="Backup integrity check passed on ${TIMESTAMP}.

Host:       ${HOSTNAME}
DB replica: s3://${S3_BUCKET}/${S3_PATH}
SQLite:     PRAGMA integrity_check → ok

No action required."
else
  SUBJECT="🚨 [${HOSTNAME}] Daily backup check FAILED – ${TIMESTAMP}"
  BODY="Backup integrity check FAILED on ${TIMESTAMP}.

Host:         ${HOSTNAME}
DB replica:   s3://${S3_BUCKET}/${S3_PATH}
Restore OK:   ${RESTORE_OK}
Integrity OK: ${INTEGRITY_OK}

--- sqlite3 output ---
${INTEGRITY_OUTPUT}

--- action required ---
Investigate litestream replication and sqlite file health immediately."
fi

echo "[check_backup] Sending report to ${ALERT_EMAIL}…"
printf "Subject: %s\nFrom: %s\nTo: %s\n\n%s\n" \
  "${SUBJECT}" \
  "${SMTP_FROM}" \
  "${ALERT_EMAIL}" \
  "${BODY}" \
  | msmtp "${ALERT_EMAIL}"

echo "[check_backup] Done. RESTORE_OK=${RESTORE_OK} INTEGRITY_OK=${INTEGRITY_OK}"

# Exit non-zero so supercronic logs the failure prominently
[ "${INTEGRITY_OK}" = "true" ] || exit 1
