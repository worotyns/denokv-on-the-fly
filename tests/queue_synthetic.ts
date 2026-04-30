import { KvQueue, KvQueueRunner } from "../lib/kv_queue.ts";

const kv = await Deno.openKv("https://denokv-on-the-fly.fly.dev");

const queue = new KvQueue(kv);

queue.handle("send-email", async (payload) => {
  console.log("sending email", payload);
});

await queue.enqueue(
  "send-email",
  {
    to: "john@example.com",
    subject: "hello",
  },
  {
    delayMs: 5000,
  },
);

const runner = new KvQueueRunner(
  kv,
  queue,
);

await runner.run({
  pollIntervalMs: 1000,
  batchSize: 20,
  lockTtlMs: 30_000,
});
