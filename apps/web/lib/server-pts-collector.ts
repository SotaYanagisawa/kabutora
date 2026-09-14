import type { IntradayBar } from "@kabutora/domain";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./cloudflare-market-env";
import { japanMarketSession } from "./market-session";
import {
  JAPANNEXT_PTS_URLS,
  japannextPtsWindowAt,
  normalizeJapanesePtsSymbol,
  parseJapannextPtsSource,
  type JapannextPtsRow,
} from "./japannext-pts";

type SourceState = {
  etag: string | null;
  last_modified: string | null;
};

type RegisteredSecurity = {
  security_id: string;
  provider_symbol: string;
};

type PtsFrameRow = {
  session_key: string;
  venue_code: "JNX_DAY" | "JNX_NIGHT";
  observed_minute: string;
  payload_json: string;
};

type PtsFramePayload = Record<string, [last: string, volume: string]>;

const SOURCE_MAX_AGE_MS = 15 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

function minuteIso(timestamp: number) {
  return new Date(Math.floor(timestamp / 60_000) * 60_000).toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "pts_collection_failed";
}

function framePayload(rows: JapannextPtsRow[]): PtsFramePayload {
  return Object.fromEntries(rows.map((row) => [row.symbol, [row.last, row.volume]]));
}

async function updateFailure(db: D1DatabaseLike, venueCode: "JNX_DAY" | "JNX_NIGHT", checkedAt: string, error: unknown) {
  await db.prepare(`
    INSERT INTO market_pts_source_state (venue_code, checked_at, failure_count, last_error)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(venue_code) DO UPDATE SET
      checked_at = excluded.checked_at,
      failure_count = market_pts_source_state.failure_count + 1,
      last_error = excluded.last_error
  `).bind(venueCode, checkedAt, errorMessage(error)).run();
}

export type PtsCollectionResult = {
  status: "stored" | "unchanged" | "outside_session" | "no_symbols" | "stale" | "failed";
  symbols: number;
  observedMinute?: string;
};

/** One invocation performs one public batch fetch and at most one frame write. */
export async function collectJapannextPts(
  db: D1DatabaseLike,
  scheduledTime: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PtsCollectionResult> {
  const scheduledDate = new Date(scheduledTime);
  const window = japannextPtsWindowAt(scheduledDate);
  if (!window || !japanMarketSession(scheduledDate).isOpen) return { status: "outside_session", symbols: 0 };
  const checkedAt = scheduledDate.toISOString();
  const registered = await db.prepare(`
    SELECT security_id, provider_symbol
    FROM market_securities
    WHERE enabled = 1 AND venue_code = 'TSE'
    ORDER BY security_id
  `).all<RegisteredSecurity>();
  const symbols = new Set((registered.results ?? []).flatMap((row) => {
    const symbol = normalizeJapanesePtsSymbol(row.provider_symbol);
    return symbol ? [symbol] : [];
  }));
  if (!symbols.size) return { status: "no_symbols", symbols: 0 };

  const state = await db.prepare("SELECT etag, last_modified FROM market_pts_source_state WHERE venue_code = ?")
    .bind(window.venueCode)
    .first<SourceState>();
  const headers = new Headers({ Accept: "text/javascript,text/plain;q=0.9" });
  if (state?.etag) headers.set("If-None-Match", state.etag);
  if (state?.last_modified) headers.set("If-Modified-Since", state.last_modified);

  try {
    const response = await fetchImpl(JAPANNEXT_PTS_URLS[window.venue], {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 304) {
      await db.prepare(`UPDATE market_pts_source_state SET checked_at = ?, failure_count = 0, last_error = NULL WHERE venue_code = ?`)
        .bind(checkedAt, window.venueCode).run();
      return { status: "unchanged", symbols: symbols.size };
    }
    if (!response.ok) throw new Error(`pts_http_${response.status}`);
    const declaredLength = Number(response.headers.get("Content-Length") ?? 0);
    if (declaredLength > 400_000) throw new Error("pts_source_too_large");
    const source = await response.text();
    const rows = parseJapannextPtsSource(source, symbols);
    if (!rows.length) throw new Error("pts_source_no_registered_rows");

    const lastModified = response.headers.get("Last-Modified");
    const sourceTimestamp = lastModified ? Date.parse(lastModified) : scheduledTime;
    if (!Number.isFinite(sourceTimestamp) || sourceTimestamp > scheduledTime + 2 * 60_000 || scheduledTime - sourceTimestamp > SOURCE_MAX_AGE_MS) {
      await updateFailure(db, window.venueCode, checkedAt, "pts_source_stale");
      return { status: "stale", symbols: rows.length };
    }
    const observedMinute = minuteIso(scheduledTime);
    const payload = JSON.stringify(framePayload(rows));
    const statements: D1PreparedStatementLike[] = [
      db.prepare(`
        INSERT INTO market_pts_frames (
          session_key, venue_code, observed_minute, source_updated_at, payload_json, symbol_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key, venue_code, observed_minute) DO UPDATE SET
          source_updated_at = excluded.source_updated_at,
          payload_json = excluded.payload_json,
          symbol_count = excluded.symbol_count,
          created_at = excluded.created_at
        WHERE excluded.source_updated_at >= market_pts_frames.source_updated_at
          AND excluded.payload_json != market_pts_frames.payload_json
      `).bind(window.sessionKey, window.venueCode, observedMinute, new Date(sourceTimestamp).toISOString(), payload, rows.length, checkedAt),
      db.prepare(`
        INSERT INTO market_pts_source_state (
          venue_code, etag, last_modified, source_updated_at, checked_at, failure_count, last_error
        ) VALUES (?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(venue_code) DO UPDATE SET
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          source_updated_at = excluded.source_updated_at,
          checked_at = excluded.checked_at,
          failure_count = 0,
          last_error = NULL
      `).bind(window.venueCode, response.headers.get("ETag"), lastModified, new Date(sourceTimestamp).toISOString(), checkedAt),
    ];
    // Delete expired rows once per day near the start of the daytime session.
    const tokyoMinute = (scheduledDate.getUTCHours() * 60 + scheduledDate.getUTCMinutes() + 9 * 60) % (24 * 60);
    if (tokyoMinute === 8 * 60 + 20) {
      statements.push(db.prepare("DELETE FROM market_pts_frames WHERE observed_minute < ?")
        .bind(new Date(scheduledTime - RETENTION_MS).toISOString()));
    }
    await db.batch(statements);
    return { status: "stored", symbols: rows.length, observedMinute };
  } catch (error) {
    await updateFailure(db, window.venueCode, checkedAt, error);
    return { status: "failed", symbols: 0 };
  }
}

export async function readLatestJapannextPtsBars(db: D1DatabaseLike, securityIds?: ReadonlySet<string>, after?: string | null) {
  const latest = await db.prepare("SELECT session_key FROM market_pts_frames ORDER BY observed_minute DESC LIMIT 1")
    .first<{ session_key: string }>();
  if (!latest?.session_key) return { bars: [] as IntradayBar[], revision: null as string | null };
  const validAfter = after && Number.isFinite(Date.parse(after)) ? after : null;
  const response = await db.prepare(`
    SELECT session_key, venue_code, observed_minute, payload_json
    FROM market_pts_frames
    WHERE session_key = ?${validAfter ? " AND observed_minute > ?" : ""}
    ORDER BY observed_minute ASC
    LIMIT 1500
  `).bind(latest.session_key, ...(validAfter ? [validAfter] : [])).all<PtsFrameRow>();
  const bars: IntradayBar[] = [];
  let revision: string | null = null;
  for (const row of response.results ?? []) {
    let payload: PtsFramePayload;
    try { payload = JSON.parse(row.payload_json) as PtsFramePayload; } catch { continue; }
    revision = row.observed_minute;
    for (const [symbol, tuple] of Object.entries(payload)) {
      const securityId = `sec-${symbol.toLowerCase()}`;
      if (securityIds && !securityIds.has(securityId)) continue;
      if (!Array.isArray(tuple) || typeof tuple[0] !== "string" || !Number.isFinite(Number(tuple[0]))) continue;
      bars.push({
        securityId,
        timestamp: row.observed_minute,
        price: tuple[0],
        provider: "japannext_pts_public",
        venueCode: row.venue_code,
        session: row.venue_code === "JNX_DAY" ? "pts_day" : "pts_night",
      });
    }
  }
  return { bars, revision };
}
