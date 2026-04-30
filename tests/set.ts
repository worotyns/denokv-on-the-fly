// # Export these in your shell or CI environment
// export DENO_KV_ACCESS_TOKEN="..." \
// Same API you know — just point at your Fly hostname
// Run: deno run --unstable-kv --unstable-cron -A tests/set.ts
const kv = await Deno.openKv("https://denokv-on-the-fly.fly.dev");
console.log("Run app... (set op)");
const result = await kv.set(["test", "users", "alice"], { name: "Alice", joined: new Date() });
console.log(result)