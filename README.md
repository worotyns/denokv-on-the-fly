# denokv-on-the-fly

> **Self-hosted [Deno KV](https://deno.com/kv) on [Fly.io](https://fly.io)** — production-ready, with continuous Litestream replication and daily backup integrity checks delivered to your inbox.

---

## Why this exists

[Deno Deploy Classic](https://dash.deno.com) is being **shut down on July 20, 2026**. The new Deno Deploy platform has significant breaking changes that affect KV users:

- **KV data is not automatically migrated** — you must contact Deno support or export it yourself.
- **`Deno.Kv.enqueue()` / `listenQueue()` (Deno Queues) are not supported** on the new platform.
- The new platform uses per-timeline database isolation, which changes how KV databases are scoped.

Self-hosting `denokv` is the cleanest escape hatch to keep using the same `Deno.openKv()` API without changing your core application code.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Fly.io VM  (shared-cpu-1x)             │
│                                                         │
│  supervisord                                            │
│  ├── litestream_start.sh                                │
│  │     • restores DB from S3 on cold boot               │
│  │     └── litestream replicate  ← continuous WAL sync  │
│  │                                                      │
│  ├── denokv_start.sh                                    │
│  │     • waits for /data/denokv.sqlite                  │
│  │     └── denokv serve :4513 (internal)                │
│  │                                                      │
│  ├── proxy.ts (Deno) :4512 (Public Entry)               │
│  │     • /lib/* → serves static files from /app/lib     │
│  │     • *      → proxies to localhost:4513 (denokv)    │
│  │                                                      │
│  └── supercronic  (crontab)                             │
│        └── 02:00 UTC daily → check_backup.sh            │
│                                                         │
│  Volume /data  (1 GB persistent)                        │
│  └── denokv.sqlite                                      │
└────────────────────────────┬────────────────────────────┘
                             │ continuous WAL replication
                             ▼
              s3://YOUR_BUCKET/denokv/
```

---

## Repository layout

```
denokv-on-the-fly/
├── Dockerfile                  # Builds the container image
├── fly.toml                    # Fly.io app config
├── lib/                        # Client libraries (served via proxy)
│   └── kv_queue.ts             # Robust Queue implementation
├── config/
│   ├── litestream.yml          # Litestream S3 replication config
│   ├── supervisord.conf        # Process supervisor
│   └── crontab                 # supercronic schedule
└── scripts/
    ├── litestream_start.sh     # Restore from S3 on boot
    ├── denokv_start.sh         # Wait for DB, then serve
    ├── proxy.ts                # Multiplexer entry point
    └── check_backup.sh         # Daily integrity check
```

---

## Migration from Deno Queues

The official `kv.enqueue` and `kv.listenQueue` methods are currently proprietary to Deno Deploy and are not implemented in the open-source `denokv` binary. 

This repository includes a drop-in capable library in `/lib/kv_queue.ts` that implements queues using standard KV atomic operations.

### Quick Migration Guide

| Feature | Official Deno API | Self-Hosted `KvQueue` |
| :--- | :--- | :--- |
| **Import** | Built-in | `import { KvQueue } from "https://<app>.fly.dev/lib/kv_queue.ts"` |
| **Setup** | `const kv = await Deno.openKv()` | `const queue = new KvQueue(kv)` |
| **Enqueuing** | `kv.enqueue(data, { delay: 5000 })` | `queue.enqueue("type", data, { delayMs: 5000 })` |
| **Listening** | `kv.listenQueue(handler)` | `queue.handle("type", handler)` + `new KvQueueRunner(kv, queue).run()` |
| **Retries** | Managed by Deno | Automatic exponential backoff + Dead Letter Queue |

---

## Setup guide

### 1. Create the Fly app and Volume

```bash
flyctl apps create your-denokv-on-the-fly-instance
flyctl volumes create denokv_data --size 1
```

### 2. Set Secrets

```bash
flyctl secrets set \
  DENO_KV_ACCESS_TOKEN="$(openssl rand -base64 32)" \
  AWS_ACCESS_KEY_ID="..." \
  AWS_SECRET_ACCESS_KEY="..." \
  S3_BUCKET="..." \
  SMTP_HOST="..." \
  SMTP_USER="..." \
  SMTP_PASSWORD="..." \
  ALERT_EMAIL="..."
```

### 3. Deploy

```bash
flyctl deploy
```

---

## Component versions

| Component | Version | Notes |
|---|---|---|
| [denokv](https://github.com/denoland/denokv) | `0.13.0` | Built from source, MIT license |
| [Deno](https://deno.com) | `latest` | Serves static files and proxies requests |
| [Litestream](https://litestream.io) | `v0.3.13` | Continuous SQLite replication |
| [Supercronic](https://github.com/aptible/supercronic) | `v0.2.33` | Container-native cron runner |

---

## License

MIT
