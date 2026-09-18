import type { D1DatabaseLike } from "./cloudflare-market-env";
import { readMarketSnapshot } from "./server-market-store";
import { portfolioMarketSessions } from "./market-session";
import type { ServerMarketSnapshot } from "./server-market-types";

export function marketSnapshotEtag(snapshot: ServerMarketSnapshot, includeIntraday: boolean) {
  const revision = includeIntraday ? snapshot.intradayRevision ?? "none" : "compact";
  return `W/"market-${includeIntraday ? "full" : "compact"}-${snapshot.savedAt ?? "empty"}-${revision}-${snapshot.coverage.quoted}-${snapshot.coverage.registered}"`;
}

/** Expensive chart reconciliation runs in a queue job, once per refresh. */
export async function prepareMarketSnapshotResponses(db: D1DatabaseLike) {
  const generatedAt = new Date().toISOString();
  const full = await readMarketSnapshot(db, true);
  const compact = { ...full, intraday: [], intradayRevision: null };
  await db.batch([full, compact].map((snapshot, index) => {
    const { generatedAt: _generatedAt, marketSessions: _sessions, ...payload } = snapshot;
    return db.prepare(`
      INSERT INTO market_response_cache (cache_key, payload_json, etag, generated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json,
        etag = excluded.etag, generated_at = excluded.generated_at
      WHERE excluded.generated_at >= market_response_cache.generated_at
    `).bind(index === 0 ? "full" : "compact", JSON.stringify(payload), marketSnapshotEtag(snapshot, index === 0), generatedAt);
  }));
}

export async function readPreparedMarketSnapshot(db: D1DatabaseLike, request: Request, includeIntraday: boolean): Promise<Response | null> {
  const row = await db.prepare("SELECT payload_json, etag, generated_at FROM market_response_cache WHERE cache_key = ?")
    .bind(includeIntraday ? "full" : "compact")
    .first<{ payload_json: string; etag: string; generated_at: string }>();
  if (!row || !row.payload_json.startsWith("{") || !row.payload_json.endsWith("}")
    || !Number.isFinite(Date.parse(row.generated_at)) || Date.now() - Date.parse(row.generated_at) > 15 * 60_000) return null;
  const headers = { ETag: row.etag, "Cache-Control": "private, no-store", "Content-Type": "application/json" };
  if (request.headers.get("If-None-Match") === row.etag) return new Response(null, { status: 304, headers });
  // Keep the server clock and session labels live without decoding/re-encoding
  // thousands of already-validated chart points on every HTTP request.
  const now = new Date();
  const prefix = JSON.stringify({ generatedAt: now.toISOString(), marketSessions: portfolioMarketSessions("ALL", now) });
  return new Response(`${prefix.slice(0, -1)},${row.payload_json.slice(1)}`, { headers });
}
