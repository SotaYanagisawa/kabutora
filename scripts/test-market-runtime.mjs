import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

/**
 * Runs the production market router + Durable Object in local workerd (real SQLite
 * storage, real routing and auth) against a fake upstream with 80 ms latency, and
 * enforces the latency, request-count and durability budgets that matter on a phone.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = path.join(root, "apps/web");
const directory = mkdtempSync(path.join(tmpdir(), "kabutora-market-runtime-"));
chmodSync(directory, 0o700);
const wrangler = path.join(web, "node_modules/wrangler/bin/wrangler.js");
const config = path.join(directory, "wrangler.json");
const state = path.join(directory, "state");
const port = Number(process.env.KABUTORA_RUNTIME_TEST_PORT ?? 8791);
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, WRANGLER_LOG_PATH: path.join(directory, "wrangler.log"), WRANGLER_SEND_METRICS: "false" };
writeFileSync(config, JSON.stringify({
  name: "kabutora-runtime-test",
  main: path.join(web, "runtime-tests/market-worker.ts"),
  compatibility_date: "2026-08-08",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: { bindings: [{ name: "MARKET_COORDINATOR", class_name: "MarketCoordinator" }] },
  migrations: [{ tag: "market-coordinator-v2", new_sqlite_classes: ["MarketCoordinator"] }],
  d1_databases: [{ binding: "MARKET_DB", database_name: "kabutora-market", database_id: "00000000-0000-4000-8000-000000000000" }],
  vars: { FIREBASE_PROJECT_ID: "synthetic-project", KABUTORA_REQUIRE_AUTH: "true", KABUTORA_ALLOWED_UIDS: "synthetic-member" },
}));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [wrangler, ...args], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { logs = (logs + data).slice(-10_000); });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(logs)));
});
let server;
let output = "";
async function start() {
  server = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", config, "--persist-to", state], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { output = (output + data).slice(-20_000); });
  const deadline = Date.now() + 60_000;
  while (true) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${origin}/__health`)).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error(`runtime_start_timeout\n${output}`);
    await wait(150);
  }
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => server.once("exit", resolve)), wait(5_000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
const timed = async (pathname, init) => {
  const started = performance.now();
  const response = await fetch(origin + pathname, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = response.status === 304 ? null : await response.text();
  return { response, ms: Math.round(performance.now() - started), json: () => JSON.parse(body) };
};
const upstreamCalls = async (query = "") => (await timed(`/__upstream${query}`)).json().calls;

const metrics = {};
try {
  // A legacy registry with exchange-qualified, duplicate and disabled rows.
  await run(["d1", "execute", "kabutora-market", "--local", "--config", config, "--persist-to", state, "--command",
    "CREATE TABLE market_securities (security_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL); INSERT INTO market_securities VALUES ('sec-7203-xtks',1),('sec-7203',1),('sec-us-aapl-xnas',1),('sec-us-voo',0);"]);
  await start();

  // Every data route requires authentication; health does not reveal symbols.
  for (const [pathname, method] of [["/api/market/snapshot", "GET"], ["/api/market/history?from=2020-01-01", "GET"], ["/api/market/distributions", "GET"], ["/api/market/registry", "POST"], ["/api/market/search", "POST"]]) {
    assert.equal((await timed(pathname, { method, body: method === "POST" ? "{}" : undefined })).response.status, 401, pathname);
  }
  assert.equal((await timed("/api/market/legacy-quotes")).response.status, 404);

  // The catalog is imported once from D1: canonical, de-duplicated, enabled rows only.
  const seeded = await timed("/__market/snapshot");
  assert.equal(seeded.response.status, 200);
  assert.deepEqual(seeded.json().quotes.map((quote) => quote.securityId).sort(), ["sec-7203", "sec-fx-usdjpy", "sec-us-aapl"]);
  metrics.coldThreeSymbolsMs = seeded.ms;

  // Cloud clients may add exactly one explicitly selected symbol per request.
  assert.equal((await timed("/__market/registry", { method: "POST", body: JSON.stringify({ securityIds: ["sec-us-a0", "sec-us-a1"] }) })).response.status, 400);
  const ids = [...Array.from({ length: 98 }, (_, index) => `sec-${1400 + index}`), ...Array.from({ length: 100 }, (_, index) => `sec-us-r${index}`)];
  for (const id of ids) assert.equal((await timed("/__market/registry", { method: "POST", body: JSON.stringify({ securityIds: [id] }) })).response.status, 200, id);
  assert.equal((await timed("/__market/registry", { method: "POST", body: JSON.stringify({ securityIds: ["sec-us-over"] }) })).response.status, 422);

  // 200 symbols: one refresh, few upstream calls, fast with 80 ms upstream latency.
  await upstreamCalls("?reset=1");
  const full = await timed("/__market/snapshot");
  const snapshot = full.json();
  metrics.fullSnapshotMs = full.ms;
  metrics.fullSnapshotBytes = JSON.stringify(snapshot).length;
  metrics.fullSnapshotUpstreamCalls = await upstreamCalls("?reset=1");
  assert.equal(snapshot.quotes.length, 201);
  assert.ok(metrics.fullSnapshotUpstreamCalls <= 25, `upstream calls ${metrics.fullSnapshotUpstreamCalls}`);
  assert.ok(full.ms < 2_000, `200-symbol refresh took ${full.ms} ms`);

  // Warm reads never touch the upstream.
  const warm = await timed("/__market/snapshot");
  metrics.warmSnapshotMs = warm.ms;
  assert.ok(warm.ms < 150, `warm read took ${warm.ms} ms`);
  assert.equal(await upstreamCalls(), 0);
  const etag = warm.response.headers.get("ETag");
  assert.equal((await timed("/__market/snapshot", { headers: { "If-None-Match": etag } })).response.status, 304);

  // A one-minute delta is small.
  const latest = Math.max(...snapshot.series.map((item) => item.t.reduce((sum, delta) => sum + delta, 0)));
  const delta = await timed(`/__market/snapshot?since=${latest - 60}&catalog=${snapshot.catalogKey}`);
  metrics.deltaBytes = JSON.stringify(delta.json()).length;
  assert.equal(delta.json().full, false);

  // Twenty phones pressing refresh at once cause one upstream refresh.
  await wait(3_200);
  await upstreamCalls("?reset=1");
  const burst = await Promise.all(Array.from({ length: 20 }, () => timed("/__market/snapshot?refresh=1")));
  assert.ok(burst.every((item) => item.response.status === 200));
  metrics.burstMaxMs = Math.max(...burst.map((item) => item.ms));
  metrics.burstUpstreamCalls = await upstreamCalls("?reset=1");
  assert.ok(metrics.burstUpstreamCalls <= 12, `burst upstream calls ${metrics.burstUpstreamCalls}`);

  // The cron tick warms history in the background within the subrequest budget.
  assert.equal((await timed("/__tick", { method: "POST" })).response.status, 204);
  metrics.tickUpstreamCalls = await upstreamCalls("?reset=1");
  assert.ok(metrics.tickUpstreamCalls <= 32, `tick upstream calls ${metrics.tickUpstreamCalls}`);
  const history = await timed("/__market/history?from=2020-01-01");
  assert.equal(history.response.status, 200);
  assert.ok(Object.keys(history.json().series).length > 0);
  assert.ok(Object.values(history.json().series).every((item) => item.rows.every(([date]) => date >= "2020-01-01")));

  // After a restart during an upstream outage, the last prices are still served.
  await stop();
  await start();
  await upstreamCalls("?fail=1");
  const restarted = await timed("/__market/snapshot");
  metrics.restartDuringOutageMs = restarted.ms;
  assert.equal(restarted.response.status, 200);
  assert.equal(restarted.json().quotes.length, 201);

  assert.ok(!/uncaughtException|unhandledRejection|SQLITE_(?:IOERR|BUSY|LOCKED)/u.test(output), output);
  console.log(JSON.stringify({ status: "market_runtime_passed", runtime: "workerd + SQLite Durable Object", upstreamLatencyMs: 80, ...metrics }));
} finally {
  await stop();
  rmSync(directory, { recursive: true, force: true });
}
