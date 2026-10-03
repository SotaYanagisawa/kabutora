import type { D1DatabaseLike } from "./cloudflare-market-env";
import { readMarketSnapshot } from "./server-market-store";
import { portfolioMarketSessions } from "./market-session";
import type { ServerMarketSnapshot } from "./server-market-types";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

export function marketSnapshotEtag(snapshot: ServerMarketSnapshot, includeIntraday: boolean) {
  const { generatedAt: _clock, marketSessions: _sessions, ...content } = snapshot;
  const payload = includeIntraday ? content : { ...content, intraday: [], intradayRevision: null };
  return `W/"market-${includeIntraday ? "full" : "compact"}-${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
}

export type PrepareSnapshotOptions = {
  minIntervalMs?: number;
};

/** Expensive chart reconciliation runs in a queue job, once per refresh. */
export async function prepareMarketSnapshotResponses(db: D1DatabaseLike, options?: PrepareSnapshotOptions): Promise<boolean> {
  if (options?.minIntervalMs && options.minIntervalMs > 0) {
    const existing = await db.prepare("SELECT generated_at FROM market_response_cache WHERE cache_key = ?")
      .bind("compact")
      .first<{ generated_at: string }>();
    if (existing?.generated_at) {
      const age = Date.now() - Date.parse(existing.generated_at);
      if (Number.isFinite(age) && age < options.minIntervalMs) {
        return false;
      }
    }
  }
  const generatedAt = new Date().toISOString();
  const full = await readMarketSnapshot(db, true);
  const compact = { ...full, intraday: [], intradayRevision: null };
  const statements = await Promise.all([full, compact].map(async (snapshot, index) => {
    const { generatedAt: _generatedAt, marketSessions: _sessions, ...payload } = snapshot;
    // D1 transports JSON strings inside another JSON response. Compress in the
    // queue, so foreground requests neither decode megabytes nor hit D1's row limit.
    const compressed = await new Response(new Response(JSON.stringify(payload).slice(1)).body!
      .pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    return db.prepare(`
      INSERT INTO market_response_cache (cache_key, payload_json, etag, generated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json,
        etag = excluded.etag, generated_at = excluded.generated_at
      WHERE excluded.generated_at >= market_response_cache.generated_at
    `).bind(index === 0 ? "full" : "compact", `gzip:${Buffer.from(compressed).toString("base64")}`, marketSnapshotEtag(snapshot, index === 0), generatedAt);
  }));
  await db.batch(statements);
  return true;
}

export async function readPreparedMarketSnapshot(db: D1DatabaseLike, request: Request, includeIntraday: boolean): Promise<Response | null> {
  const row = await db.prepare("SELECT payload_json, etag, generated_at FROM market_response_cache WHERE cache_key = ?")
    .bind(includeIntraday ? "full" : "compact")
    .first<{ payload_json: string; etag: string; generated_at: string }>();
  if (!row || !(row.payload_json.startsWith("gzip:") || (row.payload_json.startsWith("{") && row.payload_json.endsWith("}")))
    || !Number.isFinite(Date.parse(row.generated_at))) return null;
  const headers = { "X-Market-Published-At": row.generated_at, "X-Market-Server-Time": new Date().toISOString(), "X-Market-Stale": String(Date.now() - Date.parse(row.generated_at) > 15 * 60_000), ETag: row.etag, "Cache-Control": "private, no-store", "Content-Type": "application/json" };
  if (request.headers.get("If-None-Match") === row.etag) return new Response(null, { status: 304, headers });
  // Keep the server clock and session labels live without decoding/re-encoding
  // thousands of already-validated chart points on every HTTP request.
  const now = new Date();
  const prefix = JSON.stringify({ generatedAt: now.toISOString(), marketSessions: portfolioMarketSessions("ALL", now) });
  if (row.payload_json.startsWith("gzip:")) {
    const reader = new Response(Buffer.from(row.payload_json.slice(5), "base64")).body!
      .pipeThrough(new DecompressionStream("gzip")).getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${prefix.slice(0, -1)},`)); },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { headers });
  }
  return new Response(`${prefix.slice(0, -1)},${row.payload_json.slice(1)}`, { headers });
}
