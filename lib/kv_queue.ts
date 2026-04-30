type QueueJob<T = unknown> = {
  id: string;
  type: string;
  payload: T;

  runAt: number;

  attempts: number;
  maxAttempts: number;

  createdAt: number;
  lastError?: string;
};

type QueueHandler<T = unknown> = (
  payload: T,
) => Promise<void>;

function sleep(
  ms: number,
  signal?: AbortSignal,
) {
  return new Promise<void>(
    (resolve, reject) => {
      const id = setTimeout(() => {
        resolve();
      }, ms);

      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          reject(
            new Error("aborted"),
          );
        },
        {
          once: true,
        },
      );
    },
  );
}

export class KvQueue {
  #kv: Deno.Kv;

  #handlers = new Map<
    string,
    QueueHandler
  >();

  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  handle<T>(
    type: string,
    handler: QueueHandler<T>,
  ) {
    this.#handlers.set(
      type,
      handler as QueueHandler,
    );
  }

  async enqueue<T>(
    type: string,
    payload: T,
    options?: {
      delayMs?: number;
      maxAttempts?: number;
    },
  ) {
    const now = Date.now();

    const job: QueueJob<T> = {
      id: crypto.randomUUID(),
      type,
      payload,

      runAt: now + (options?.delayMs ?? 0),

      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,

      createdAt: now,
    };

    await this.#kv.atomic()
      .set(
        ["queue", "jobs", job.id],
        job,
      )
      .set(
        [
          "queue",
          "scheduled",
          job.runAt,
          job.id,
        ],
        null,
      )
      .commit();

    return job.id;
  }

  async process(options?: {
    batchSize?: number;
    lockMs?: number;
  }) {
    const batchSize = options?.batchSize ?? 20;

    const lockMs = options?.lockMs ?? 30_000;

    const now = Date.now();

    const scheduled = this.#kv.list({
      start: ["queue", "scheduled", 0],
      end: [
        "queue",
        "scheduled",
        now,
        "\uffff",
      ],
    });

    const jobIds: string[] = [];

    for await (const entry of scheduled) {
      const id = entry.key[3] as string;

      jobIds.push(id);

      if (jobIds.length >= batchSize) {
        break;
      }
    }

    if (jobIds.length === 0) {
      return 0;
    }

    let processed = 0;

    await Promise.all(
      jobIds.map(async (jobId) => {
        const ok = await this.#processJob(
          jobId,
          lockMs,
        );

        if (ok) {
          processed++;
        }
      }),
    );

    return processed;
  }

  async #processJob(
    jobId: string,
    lockMs: number,
  ) {
    const jobKey = [
      "queue",
      "jobs",
      jobId,
    ];

    const lockKey = [
      "queue",
      "job-lock",
      jobId,
    ];

    const jobRes = await this.#kv.get<QueueJob>(
      jobKey,
    );

    if (!jobRes.value) {
      return false;
    }

    const job = jobRes.value;

    const lockResult = await this.#kv.atomic()
      .check({
        key: lockKey,
        versionstamp: null,
      })
      .set(
        lockKey,
        {
          lockedAt: Date.now(),
        },
        {
          expireIn: lockMs,
        },
      )
      .commit();

    if (!lockResult.ok) {
      return false;
    }

    try {
      const handler = this.#handlers.get(job.type);

      if (!handler) {
        throw new Error(
          `Missing handler: ${job.type}`,
        );
      }

      await handler(job.payload);

      await this.#kv.atomic()
        .delete(jobKey)
        .delete([
          "queue",
          "scheduled",
          job.runAt,
          job.id,
        ])
        .delete(lockKey)
        .commit();

      return true;
    } catch (err) {
      const attempts = job.attempts + 1;

      if (
        attempts >= job.maxAttempts
      ) {
        await this.#kv.atomic()
          .set(
            [
              "queue",
              "dead-letter",
              job.id,
            ],
            {
              ...job,
              attempts,
              lastError: String(err),
            },
          )
          .delete(jobKey)
          .delete([
            "queue",
            "scheduled",
            job.runAt,
            job.id,
          ])
          .delete(lockKey)
          .commit();

        console.error(
          "Job dead-lettered:",
          job.id,
        );

        return false;
      }

      const retryDelay = Math.min(
        60_000,
        1000 * 2 ** attempts,
      );

      const updated: QueueJob = {
        ...job,
        attempts,
        lastError: String(err),
        runAt: Date.now() + retryDelay,
      };

      await this.#kv.atomic()
        .set(jobKey, updated)
        .delete([
          "queue",
          "scheduled",
          job.runAt,
          job.id,
        ])
        .set(
          [
            "queue",
            "scheduled",
            updated.runAt,
            updated.id,
          ],
          null,
        )
        .delete(lockKey)
        .commit();

      console.error(
        "Job retry:",
        job.id,
      );

      return false;
    }
  }
}

export class KvQueueRunner {
  #kv: Deno.Kv;

  #queue: KvQueue;

  #workerId = crypto.randomUUID();

  #running = false;

  #abort = new AbortController();

  #runPromise?: Promise<void>;

  #heartbeatPromise?: Promise<void>;

  constructor(
    kv: Deno.Kv,
    queue: KvQueue,
  ) {
    this.#kv = kv;
    this.#queue = queue;
  }

  async run(options?: {
    pollIntervalMs?: number;
    lockTtlMs?: number;
    batchSize?: number;
    idleSleepMs?: number;
  }) {
    if (this.#running) {
      throw new Error(
        "Runner already running",
      );
    }

    this.#running = true;

    const pollIntervalMs = options?.pollIntervalMs ?? 1000;

    const lockTtlMs = options?.lockTtlMs ?? 15_000;

    const batchSize = options?.batchSize ?? 20;

    const idleSleepMs = options?.idleSleepMs ?? 3000;

    this.#runPromise = (async () => {
      while (this.#running) {
        try {
          const leadership = await this.#acquireLeadership(
            lockTtlMs,
          );

          if (!leadership) {
            await sleep(
              pollIntervalMs,
              this.#abort.signal,
            );

            continue;
          }

          this.#heartbeatPromise = this.#heartbeatLoop(
            lockTtlMs,
          );

          const processed = await this.#queue.process({
            batchSize,
            lockMs: lockTtlMs,
          });

          if (processed === 0) {
            await sleep(
              idleSleepMs,
              this.#abort.signal,
            );
          } else {
            await sleep(
              pollIntervalMs,
              this.#abort.signal,
            );
          }
        } catch (err) {
          if (
            err instanceof Error &&
            err.message === "aborted"
          ) {
            break;
          }

          console.error(
            "Queue runner error:",
            err,
          );

          try {
            await sleep(1000, this.#abort.signal);
          } catch {
            break;
          }
        }
      }

      await this.#heartbeatPromise;
      await this.#releaseLeadership();
    })();

    return this.#runPromise;
  }

  async stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#abort.abort();
    await this.#runPromise;
  }

  async #acquireLeadership(
    ttlMs: number,
  ) {
    const key = [
      "queue",
      "runner-leader",
    ];

    const now = Date.now();

    const current = await this.#kv.get<{
      workerId: string;
      expiresAt: number;
    }>(key);

    const expired = !current.value ||
      current.value.expiresAt < now;

    const mine = current.value?.workerId ===
      this.#workerId;

    if (!expired && !mine) {
      return false;
    }

    const result = await this.#kv.atomic()
      .check(current)
      .set(
        key,
        {
          workerId: this.#workerId,
          expiresAt: now + ttlMs,
        },
        {
          expireIn: ttlMs,
        },
      )
      .commit();

    return result.ok;
  }
  async #heartbeatLoop(
    ttlMs: number,
  ) {
    const interval = Math.floor(ttlMs / 3);

    while (this.#running) {
      try {
        await sleep(
          interval,
          this.#abort.signal,
        );

        const key = [
          "queue",
          "runner-leader",
        ];

        const current = await this.#kv.get<{
          workerId: string;
        }>(key);

        if (
          current.value?.workerId !==
            this.#workerId
        ) {
          continue;
        }

        await this.#kv.set(
          key,
          {
            workerId: this.#workerId,
            expiresAt: Date.now() + ttlMs,
          },
          {
            expireIn: ttlMs,
          },
        );
      } catch (err) {
        if (
          err instanceof Error &&
          err.message === "aborted"
        ) {
          break;
        }

        console.error(
          "Heartbeat error:",
          err,
        );
      }
    }
  }

  #stopHeartbeat() {
    // Deprecated in favor of AbortController
  }

  async #releaseLeadership() {
    const key = [
      "queue",
      "runner-leader",
    ];

    const current = await this.#kv.get<{
      workerId: string;
    }>(key);

    if (
      current.value?.workerId ===
        this.#workerId
    ) {
      await this.#kv.delete(key);
    }
  }
}
