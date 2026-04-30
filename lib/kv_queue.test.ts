import { assertEquals, assertRejects } from "jsr:@std/assert";

import { KvQueue, KvQueueRunner } from "./kv_queue.ts";

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => {
      resolve();
    }, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

Deno.test("enqueue + process job", async () => {
  const kv = await Deno.openKv(":memory:");
  const abort = new AbortController();

  try {
    const queue = new KvQueue(kv);

  const processed: string[] = [];

  queue.handle(
    "email",
    async (payload: { to: string }) => {
      processed.push(payload.to);
    },
  );

  await queue.enqueue("email", {
    to: "john@example.com",
  });

  const count = await queue.process();

  assertEquals(count, 1);

    await sleep(50, abort.signal);

    assertEquals(processed, [
      "john@example.com",
    ]);

    const jobs = kv.list({
      prefix: ["queue", "jobs"],
    });

    const remaining = [];

    for await (const j of jobs) {
      remaining.push(j);
    }

    assertEquals(remaining.length, 0);
  } finally {
    abort.abort();
    kv.close();
  }
});

Deno.test("delayed job does not execute early", async () => {
  const kv = await Deno.openKv(":memory:");
  const abort = new AbortController();

  try {
    const queue = new KvQueue(kv);

  let called = false;

  queue.handle("test", async () => {
    called = true;
  });

  await queue.enqueue(
    "test",
    {},
    {
      delayMs: 1000,
    },
  );

  const count1 = await queue.process();

  assertEquals(count1, 0);

  assertEquals(called, false);

    await sleep(1100, abort.signal);

    const count2 = await queue.process();

    assertEquals(count2, 1);

    assertEquals(called, true);
  } finally {
    abort.abort();
    kv.close();
  }
});

Deno.test("retry failed job", async () => {
  const kv = await Deno.openKv(":memory:");
  const abort = new AbortController();

  try {
    const queue = new KvQueue(kv);

  let attempts = 0;

  queue.handle("retry", async () => {
    attempts++;

    if (attempts < 2) {
      throw new Error("fail");
    }
  });

  await queue.enqueue(
    "retry",
    {},
  );

  const first = await queue.process();

  assertEquals(first, 0);

  assertEquals(attempts, 1);

    await sleep(2200, abort.signal);

    const second = await queue.process();

    assertEquals(second, 1);

    assertEquals(attempts, 2);
  } finally {
    abort.abort();
    kv.close();
  }
});

Deno.test("dead-letter after max attempts", async () => {
  const kv = await Deno.openKv(":memory:");
  const abort = new AbortController();

  try {
    const queue = new KvQueue(kv);

  let attempts = 0;

  queue.handle("fail", async () => {
    attempts++;

    throw new Error("boom");
  });

  await queue.enqueue(
    "fail",
    {},
    {
      maxAttempts: 2,
    },
  );

  await queue.process();

    await sleep(2200, abort.signal);

    await queue.process();

    assertEquals(attempts, 2);

    const deadEntries = kv.list({
      prefix: ["queue", "dead-letter"],
    });

    const items = [];

    for await (const item of deadEntries) {
      items.push(item);
    }

    assertEquals(items.length, 1);
  } finally {
    abort.abort();
    kv.close();
  }
});

Deno.test("runner processes jobs automatically", async () => {
  const kv = await Deno.openKv(":memory:");
  const abort = new AbortController();

  try {
    const queue = new KvQueue(kv);

  const processed: number[] = [];

  queue.handle(
    "job",
    async (payload: number) => {
      processed.push(payload);
    },
  );

  const runner = new KvQueueRunner(kv, queue);

  const runPromise = runner.run({
    pollIntervalMs: 100,
    idleSleepMs: 100,
    batchSize: 10,
    lockTtlMs: 5000,
  });

  await queue.enqueue(
    "job",
    123,
  );

    await sleep(500, abort.signal);

    await runner.stop();

    await Promise.race([
      runPromise,
      sleep(1000, abort.signal),
    ]);

    assertEquals(processed, [123]);
  } finally {
    abort.abort();
    kv.close();
  }
});

Deno.test("multiple runners do not overlap", async () => {
  const kv = await Deno.openKv(":memory:");
  const abort = new AbortController();

  try {
    const queue = new KvQueue(kv);

  let executions = 0;

  queue.handle(
    "unique",
    async () => {
      executions++;

      await sleep(300);
    },
  );

  const runner1 = new KvQueueRunner(kv, queue);

  const runner2 = new KvQueueRunner(kv, queue);

  const p1 = runner1.run({
    pollIntervalMs: 50,
    idleSleepMs: 50,
    lockTtlMs: 1000,
  });

  const p2 = runner2.run({
    pollIntervalMs: 50,
    idleSleepMs: 50,
    lockTtlMs: 1000,
  });

    await queue.enqueue(
      "unique",
      {},
    );

    await sleep(1000, abort.signal);

    await runner1.stop();
    await runner2.stop();

    await Promise.race([
      Promise.all([p1, p2]),
      sleep(2000, abort.signal),
    ]);

    assertEquals(executions, 1);
  } finally {
    abort.abort();
    kv.close();
  }
});

Deno.test("cannot start runner twice", async () => {
  const kv = await Deno.openKv(":memory:");
  const queue = new KvQueue(kv);
  const runner = new KvQueueRunner(kv, queue);

  try {
    // Start first runner
    const p1 = runner.run({
      pollIntervalMs: 100,
    });

    // Try starting second runner
    await assertRejects(
      async () => {
        await runner.run();
      },
      Error,
      "Runner already running",
    );

    await runner.stop();
    await p1;
  } finally {
    kv.close();
  }
});
