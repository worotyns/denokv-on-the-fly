// # Export these in your shell or CI environment
// export DENO_KV_ACCESS_TOKEN="..." \
// Same API you know — just point at your Fly hostname
// Run: deno run --unstable-kv --unstable-cron -A tests/main.ts
const kv = await Deno.openKv("https://denokv-on-the-fly.fly.dev");
const kvLocal = await Deno.openKv(":memory:");

console.log("Run app... (kv, cron, get, set)");

await kv.set(["test", "users", "alice"], { name: "Alice", joined: new Date() });
const result = await kv.get(["test", "users", "alice"]);

console.log("KV get / set: ", result.value); // { name: "Alice", joined: ... }

// Describe the shape of your message object (optional)
interface Notification {
    forUser: string;
    body: string;
}

console.log("KV Open");

function isNotification(msg) {
    return msg?.forUser && msg?.body && msg?.time;
}

// Register a handler function to listen for values - this example shows
// how you might send a notification
kvLocal.listenQueue((msg: unknown) => {
    console.log("Listen queue message", msg);
    // Use type guard - then TypeScript compiler knows msg is a Notification
    if (isNotification(msg)) {
        console.log("Sending notification to user:", msg.forUser);
        // ... do something to actually send the notification!
    } else {
        // If the message is of an unknown type, it might be an error
        console.error("Unknown message received:", msg);
    }
});

Deno.cron("Run once a minute", "* * * * *", () => {
    console.log("Execute cron");
    // Create a notification object
    const message: Notification = {
        forUser: "alovelace",
        body: "You've got mail!",
        time: new Date(),
    };

    // Enqueue the message for immediate delivery
    kvLocal.enqueue(message);
});
