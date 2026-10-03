import assert from "node:assert/strict";

/**
 * Production smoke test: the deployed app loads, its assets exist, market data is
 * private, and the market object answers quickly with fresh prices.
 * Usage: node scripts/verify-production.mjs [origin]
 */
const origin = (process.argv[2] ?? process.env.KABUTORA_ORIGIN ?? "https://kabutora.kabutora-7a4e.workers.dev").replace(/\/$/u, "");
const timed = async (path, init) => {
  const started = performance.now();
  const response = await fetch(origin + path, { redirect: "manual", ...init, signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  return { response, body, ms: Math.round(performance.now() - started) };
};

const page = await timed("/");
assert.equal(page.response.status, 200, "origin");
const assets = [...new Set([...page.body.matchAll(/\/_next\/static\/[^"'\s)\\]+/gu)].map((match) => match[0]))];
assert.ok(assets.length > 0, "HTML references no frontend assets");
for (const asset of assets) assert.equal((await timed(asset)).response.status, 200, asset);
const version = JSON.parse((await timed("/api/version")).body);

for (const [path, method] of [["/api/market/snapshot", "GET"], ["/api/market/history?from=2025-01-01", "GET"], ["/api/market/registry", "POST"]]) {
  const denied = await timed(path, { method, body: method === "POST" ? "{}" : undefined });
  assert.equal(denied.response.status, 401, `${path} must require authentication`);
  assert.match(denied.response.headers.get("Cache-Control") ?? "", /no-store/u);
}

const samples = [];
for (let index = 0; index < 5; index += 1) samples.push(await timed("/api/market/health"));
const health = JSON.parse(samples.at(-1).body);
assert.equal(samples.at(-1).response.status, 200, "market health");
assert.ok(health.quotes > 0, "market object has no quotes");
assert.ok(health.ageSeconds < 120, `market data is ${health.ageSeconds}s old`);
const latencies = samples.map((sample) => sample.ms).sort((left, right) => left - right);
console.log(JSON.stringify({
  status: "production_verified",
  origin,
  buildId: version.buildId,
  assets: assets.length,
  market: { quotes: health.quotes, ageSeconds: health.ageSeconds, firstMs: samples[0].ms, medianMs: latencies[2], maxMs: latencies.at(-1) },
}));
