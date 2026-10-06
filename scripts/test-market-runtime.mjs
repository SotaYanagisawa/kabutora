import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

/**
 * Runs the production market router + Durable Object in local workerd (real SQLite storage, real
 * routing and auth) against a fake upstream with 80 ms latency, and enforces the latency,
 * request-count and durability budgets that matter on a phone.
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
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(logs))));
});
let server;
let output = "";
async function start() {
  server = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--config", config, "--persist-to", state], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { output = (output + data).slice(-20_000); });
  const deadline = Date.now() + 60_000;
  while (true) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${origin}/__health`)).ok) return; } catch { /* Not listening yet. */ }
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
  const response = await fetch(origin + pathname, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = response.status === 304 ? null : await response.text();
  return { response, ms: Math.round(performance.now() - started), json: () => JSON.parse(body) };
};
const upstream = async (query = "") => (await timed(`/__upstream${query}`)).json();

const metrics = {};
try {
  // A legacy registry with exchange-qualified, duplicate and disabled rows.
  await run(["d1", "execute", "kabutora-market", "--local", "--config", config, "--persist-to", state, "--command",
    "CREATE TABLE market_securities (security_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL); INSERT INTO market_securities VALUES ('sec-7203-xtks',1),('sec-7203',1),('sec-us-aapl-xnas',1),('sec-us-voo',0);"]);
  await start();

  // Every data route requires authentication; health does not reveal symbols.
  for (const [pathname, method] of [["/api/market/snapshot", "GET"], ["/api/market/history?from=2026-01-01", "GET"], ["/api/market/registry", "POST"], ["/api/market/search", "POST"]]) {
    assert.equal((await timed(pathname, { method, body: method === "POST" ? "{}" : undefined })).response.status, 401, pathname);
  }
  assert.equal((await timed("/api/market/distributions")).response.status, 404);

  // Cold snapshot: the D1 catalog is imported once and normalized to one key per security.
  await upstream("?reset=1");
  const cold = await timed("/__market/snapshot");
  assert.equal(cold.response.status, 200);
  const coldBody = cold.json();
  assert.deepEqual(coldBody.catalog, ["sec-7203", "sec-us-aapl"]);
  assert.deepEqual(coldBody.quotes.map((quote) => quote.key).sort(), ["sec-7203", "sec-fx-usdjpy", "sec-us-aapl"]);
  assert.ok(coldBody.intraday["sec-7203"].t.length > 10, "intraday series");
  metrics.coldSnapshotMs = cold.ms;
  assert.ok(cold.ms < 3_500, `cold snapshot ${cold.ms} ms`);

  // Warm reads are served from memory without upstream calls; unchanged data answers 304.
  await upstream("?reset=1");
  const warm = await timed(`/__market/snapshot?intraday=${coldBody.intradayRevision}`);
  metrics.warmSnapshotMs = warm.ms;
  assert.ok(warm.ms < 150, `warm snapshot ${warm.ms} ms`);
  assert.equal(warm.json().intraday, undefined);
  const etag = warm.response.headers.get("ETag");
  assert.equal((await timed("/__market/snapshot", { headers: { "If-None-Match": etag } })).response.status, 304);
  assert.equal((await upstream()).paths["spark:1d"] ?? 0, 0);

  // 20 simultaneous forced refreshes share one upstream refresh.
  await wait(3_100);
  await upstream("?reset=1");
  await Promise.all(Array.from({ length: 20 }, () => timed("/__market/snapshot?refresh=1")));
  assert.equal((await upstream()).paths["spark:1d"], 1);

  // Cloud clients add one explicitly selected security per request.
  assert.equal((await timed("/__market/registry", { method: "POST", body: JSON.stringify({ securityIds: ["sec-285a-xtks", "sec-7203"] }) })).response.status, 400);
  assert.equal((await timed("/__market/registry", { method: "POST", body: JSON.stringify({ securityIds: ["sec-285a-xtks"] }) })).response.status, 200);
  // The client refreshes right after a registration; the new security is priced at once.
  assert.ok((await timed("/__market/snapshot")).json().quotes.some((quote) => quote.key === "sec-285a"), "registered security priced");

  // History: one record per security; the split arrives with the closes it adjusted.
  const history = await timed("/__market/history?from=2025-01-01");
  const historyBody = history.json();
  metrics.historyMs = history.ms;
  assert.deepEqual(historyBody.pending, []);
  assert.deepEqual(historyBody.records["sec-285a"].s, [["2026-09-29", 3]]);
  assert.ok(historyBody.records["sec-7203"].p.length > 200);
  const historyEtag = history.response.headers.get("ETag");
  assert.equal((await timed("/__market/history?from=2025-01-01", { headers: { "If-None-Match": historyEtag } })).response.status, 304);

  // The cron tick runs inside the object.
  assert.equal((await timed("/__tick")).response.status, 204);

  // Restart during an outage: the catalog, quotes and history survive in SQLite.
  await stop();
  await start();
  await upstream("?fail=1");
  const restored = await timed("/__market/snapshot");
  assert.equal(restored.response.status, 200);
  assert.ok(restored.json().quotes.some((quote) => quote.key === "sec-285a"), "restored quotes");
  assert.equal((await timed("/__market/history?from=2025-01-01")).json().records["sec-285a"].s.length, 1);
  await upstream("?fail=0");
  console.log(JSON.stringify({ ok: true, ...metrics }));
} finally {
  await stop();
  rmSync(directory, { recursive: true, force: true });
}
