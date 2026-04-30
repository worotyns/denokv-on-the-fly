# denokv-on-the-fly

> **Self-hosted [Deno KV](https://deno.com/kv) on [Fly.io](https://fly.io)** — production-ready, with continuous Litestream replication and daily backup integrity checks delivered to your inbox.

---

## Why this exists

[Deno Deploy Classic](https://dash.deno.com) is being **shut down on July 20, 2026**. The new Deno Deploy platform has significant breaking changes that affect KV users:

- **KV data is not automatically migrated** — you must contact Deno support or export it yourself.
- **`Deno.Kv.enqueue()` / `listenQueue()` (Deno Queues) are not supported** on the new platform.
- The new platform uses per-timeline database isolation, which changes how KV databases are scoped.

See the [official Deno Deploy migration guide](https://docs.deno.com/deploy/migration_guide/) for full details.

If you depend on Deno KV today and want to keep using the same `Deno.openKv()` API without changing your application code, **self-hosting `denokv` is the cleanest escape hatch**. You get:

- ✅ Full KV-Connect protocol compatibility — your code stays the same
- ✅ A persistent SQLite backend, battle-tested by the Deno team
- ✅ Continuous WAL replication via [Litestream](https://litestream.io) to any S3-compatible bucket
- ✅ Daily backup integrity verification with e-mail alerts
- ✅ Point-in-time recovery (PITR)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Fly.io VM  (shared-cpu-1x)             │
│                                                         │
│  supervisord                                            │
│  ├── litestream_start.sh                                │
│  │     • renders /etc/msmtprc from SMTP_* secrets       │
│  │     • restores DB from S3 on cold boot               │
│  │     └── litestream replicate  ← continuous WAL sync  │
│  │                                                      │
│  ├── denokv_start.sh                                    │
│  │     • polls until /data/denokv.sqlite exists         │
│  │     └── denokv serve :4512 (KV-Connect protocol)    │
│  │                                                      │
│  └── supercronic  (crontab)                             │
│        └── 02:00 UTC daily → check_backup.sh            │
│              • litestream restore → /tmp/               │
│              • sqlite3 PRAGMA integrity_check           │
│              └── msmtp → ALERT_EMAIL  ✅ / 🚨            │
│                                                         │
│  Volume /data  (1 GB persistent)                        │
│  └── denokv.sqlite                                      │
└────────────────────────────┬────────────────────────────┘
                             │ continuous WAL replication
                             ▼
              s3://YOUR_BUCKET/denokv/
              (7-day PITR retention)
```

---

## Repository layout

```
denokv-on-the-fly/
├── Dockerfile                  # Builds the container image
├── fly.toml                    # Fly.io app config (1 GB volume, port 4512)
├── config/
│   ├── litestream.yml          # Litestream S3 replication config
│   ├── supervisord.conf        # Process supervisor (manages all 3 services)
│   ├── msmtprc                 # msmtp TLS template (rendered at runtime)
│   └── crontab                 # supercronic schedule (daily at 02:00 UTC)
└── scripts/
    ├── litestream_start.sh     # Restore from S3 on boot, then replicate
    ├── denokv_start.sh         # Wait for DB, then serve KV-Connect
    └── check_backup.sh         # Restore → integrity check → e-mail report
```

---

## Prerequisites

| Tool | Install |
|---|---|
| [flyctl](https://fly.io/docs/flyctl/install/) | `brew install flyctl` |
| An S3-compatible bucket | AWS S3, [Fly Tigris](https://fly.io/docs/reference/tigris/), Backblaze B2, MinIO, … |
| An SMTP account | Any provider: SendGrid, Postmark, Mailgun, Gmail SMTP, … |

---

## Setup guide

### 1. Clone and enter the project

```bash
git clone https://github.com/YOUR_USERNAME/denokv-on-the-fly.git
cd denokv-on-the-fly
```

### 2. Authenticate with Fly

```bash
flyctl auth login
```

### 3. Create the Fly app

```bash
flyctl apps create denokv-on-the-fly
# or pick your own app name – remember to update fly.toml
```

### 4. Create the persistent volume (1 GB)

```bash
flyctl volumes create denokv_data \
  --app denokv-on-the-fly \
  --region waw \       # change to your preferred region
  --size 1
```

> **Tip — using Fly Tigris as your S3 bucket:**
> ```bash
> flyctl storage create --app denokv-on-the-fly
> ```
> This creates a bucket and automatically sets `AWS_ACCESS_KEY_ID`,
> `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, and `BUCKET_NAME` as
> secrets. Map them to the Litestream secrets in step 5.

### 5. Set secrets

**If you used `flyctl storage create` (Tigris):** it automatically injects `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `BUCKET_NAME` as secrets. You only need to map the bucket name and add SMTP + KV token:

```bash
# Get the bucket name Tigris created
flyctl secrets list --app denokv-on-the-fly
# Look for BUCKET_NAME in the output, then:

flyctl secrets set \
  DENO_KV_ACCESS_TOKEN="$(openssl rand -base64 32)" \
  S3_BUCKET="<value-of-BUCKET_NAME>" \
  SMTP_HOST="smtp.example.com" \
  SMTP_PORT="587" \
  SMTP_USER="alerts@example.com" \
  SMTP_PASSWORD="<smtp-password>" \
  SMTP_FROM="denokv-alerts@example.com" \
  ALERT_EMAIL="ops@example.com" \
  --app denokv-on-the-fly
```

**If you're using your own S3/B2/MinIO (not Tigris):** set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` manually:

```bash
flyctl secrets set \
  DENO_KV_ACCESS_TOKEN="$(openssl rand -base64 32)" \
  AWS_ACCESS_KEY_ID="<s3-access-key>" \
  AWS_SECRET_ACCESS_KEY="<s3-secret-key>" \
  S3_BUCKET="<your-bucket-name>" \
  SMTP_HOST="smtp.example.com" \
  SMTP_PORT="587" \
  SMTP_USER="alerts@example.com" \
  SMTP_PASSWORD="<smtp-password>" \
  SMTP_FROM="denokv-alerts@example.com" \
  ALERT_EMAIL="ops@example.com" \
  --app denokv-on-the-fly
```

> **SMTP notes:**
> - Port `587` with STARTTLS is the default (most providers).
> - For port `465` (implicit TLS), change `tls_starttls on` → `off` in `scripts/litestream_start.sh` before deploying.

> **S3_PATH** and **S3_ENDPOINT** are set in `fly.toml [env]` (not secrets):
> - `S3_PATH = "denokv/"` — key prefix inside the bucket
> - `S3_ENDPOINT = "https://fly.storage.tigris.dev"` — remove this line if using AWS S3 directly

### 6. Deploy

```bash
flyctl deploy --app denokv-on-the-fly
```

The first deploy will:
1. Build the Docker image (downloads `denokv`, `litestream`, `supercronic`)
2. Attempt to restore from your S3 bucket (no-op on first run — starts fresh)
3. Start `denokv`, `litestream`, and `supercronic` under `supervisord`

### 7. Connect from your Deno app

```bash
# Export these in your shell or CI environment
export DENO_KV_ACCESS_TOKEN="<the token you set above>"
```

```ts
// Same API you know — just point at your Fly hostname
const kv = await Deno.openKv("https://denokv-on-the-fly.fly.dev");

await kv.set(["users", "alice"], { name: "Alice", joined: new Date() });
const result = await kv.get(["users", "alice"]);
console.log(result.value); // { name: "Alice", joined: ... }
```

---

## How the daily backup check works

Every night at **02:00 UTC** `supercronic` runs `scripts/check_backup.sh`:

1. **Restore** — `litestream restore` pulls the latest snapshot from S3 into `/tmp/backup-check/<timestamp>/`
2. **Integrity** — `sqlite3 PRAGMA integrity_check` verifies the restored file is not corrupted
3. **Report** — `msmtp` sends an e-mail to `ALERT_EMAIL`:
   - ✅ **PASSED** — everything is fine, no action needed
   - 🚨 **FAILED** — restore or integrity check failed, includes full output for diagnosis

The temporary restore directory is deleted automatically after the check, regardless of outcome.

---

## Operations

### View live logs

```bash
flyctl logs --app denokv-on-the-fly
```

### Check process health inside the VM

```bash
flyctl ssh console --app denokv-on-the-fly
supervisorctl status
# litestream   RUNNING   pid 12, uptime 0:04:21
# denokv       RUNNING   pid 34, uptime 0:04:18
# supercronic  RUNNING   pid 56, uptime 0:04:18
```

### Trigger a manual backup integrity check

```bash
flyctl ssh console --app denokv-on-the-fly
/app/scripts/check_backup.sh
```

### Point-in-time recovery (PITR)

```bash
flyctl ssh console --app denokv-on-the-fly

# 1. Stop live services
supervisorctl stop denokv litestream

# 2. List recoverable versionstamps
litestream restore -config /etc/litestream/litestream.yml /data/denokv_check.sqlite
denokv --sqlite-path /data/denokv_check.sqlite pitr list

# 3. Check out a specific point in time
denokv --sqlite-path /data/denokv.sqlite pitr checkout <VERSIONSTAMP>

# 4. Restart in read-only mode (no sync from S3)
supervisorctl start litestream
denokv --sqlite-path /data/denokv.sqlite serve \
  --addr 0.0.0.0:4512 \
  --read-only \
  --access-token "$DENO_KV_ACCESS_TOKEN"
```

### Scale up

```bash
# More CPU
flyctl scale vm performance-1x --app denokv-on-the-fly

# More memory
flyctl scale memory 1024 --app denokv-on-the-fly

# Larger volume
flyctl volumes extend <volume-id> --size 5 --app denokv-on-the-fly
```

---

## Environment variables reference

| Variable | Set in | Description |
|---|---|---|
| `DENO_KV_ACCESS_TOKEN` | Fly secret | Bearer token for KV-Connect clients |
| `AWS_ACCESS_KEY_ID` | Fly secret | S3 access key — auto-set by `flyctl storage create` (Tigris) |
| `AWS_SECRET_ACCESS_KEY` | Fly secret | S3 secret key — auto-set by `flyctl storage create` (Tigris) |
| `S3_BUCKET` | Fly secret | Bucket name — map from `BUCKET_NAME` that Tigris creates |
| `S3_PATH` | `fly.toml [env]` | Key prefix inside the bucket (default `denokv/`) |
| `S3_ENDPOINT` | `fly.toml [env]` | S3-compatible endpoint — pre-set to Tigris URL; remove for AWS S3 |
| `SMTP_HOST` | Fly secret | SMTP server hostname |
| `SMTP_PORT` | Fly secret | `587` (STARTTLS) or `465` (implicit TLS) |
| `SMTP_USER` | Fly secret | SMTP login username |
| `SMTP_PASSWORD` | Fly secret | SMTP password |
| `SMTP_FROM` | Fly secret | Sender address in alert e-mails |
| `ALERT_EMAIL` | Fly secret | Recipient for daily backup check report |
| `DENOKV_ADDR` | optional env | Override bind address (default `0.0.0.0:4512`) |

---

## Component versions

| Component | Version | Notes |
|---|---|---|
| [denokv](https://github.com/denoland/denokv) | `0.7.0` | KV-Connect server, MIT license |
| [Litestream](https://litestream.io) | `v0.3.13` | Continuous SQLite replication |
| [Supercronic](https://github.com/aptible/supercronic) | `v0.2.33` | Container-native cron runner |
| [msmtp](https://marlam.de/msmtp/) | Debian bookworm | Lightweight MTA for alert e-mails |
| Base image | `debian:bookworm-slim` | — |

To upgrade any component, change the corresponding `ARG` in the `Dockerfile` and redeploy.

---

## License

MIT
