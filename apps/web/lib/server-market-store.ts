import { canonicalDomainSecurityId, type CorporateAction, type DistributionEvent, type IntradayBar, type MarketBar } from "@kabutora/domain";
import { inspectMarketHistory } from "./market-history";
import { sanitizeIntradayBars } from "./intraday-cache";
import { portfolioMarketSessions } from "./market-session";
import { exchangeTimeZone, latestIntradaySessionBars, marketSessionDateKey, recentIntradaySessionBars, sparkline24HourBars } from "./chart-presentation";
import { readLatestJapannextPtsBars } from "./server-pts-collector";
import { normalizeRequestedSecurity, type RequestedSecurity } from "./market-security";
import type { D1DatabaseLike, D1PreparedStatementLike } from "./cloudflare-market-env";
import type {
  DistributionCoverage,
  MarketHistoryBatchResult,
  MarketQuoteBatchResult,
  MarketRefreshJob,
  PublicSecurityDescriptor,
  ServerBenchmark,
  ServerMarketSnapshot,
  ServerRemoteQuote,
} from "./server-market-types";

const isoNow = () => new Date().toISOString();

function canonicalAndExactVariants(id: string): string[] {
  const canonical = canonicalDomainSecurityId(id);
  return canonical === id ? [id] : [id, canonical];
}

function publicSecurityIdVariants(ids: string[]) {
  return [...new Set(ids.flatMap((id) => {
    const lower = id.toLowerCase().trim();
    const jpMatch = /^(?:sec-)?([0-9]{4}|[0-9]{3}[a-z])(?:\.t)?(?:-(?:xtks|tse))?$/i.exec(lower);
    if (jpMatch) {
      const code = jpMatch[1].toLowerCase();
      return [`sec-${code}`, `sec-${code}-xtks`, `sec-${code}-tse`];
    }
    const usMatch = /^sec-us-([a-z0-9.-]+?)(?:-(?:xnas|xnys|arcx|xase|bats|otcm|xams))?$/i.exec(lower);
    if (usMatch) {
      const sym = usMatch[1].toLowerCase();
      const base = `sec-us-${sym}`;
      return [base, `${base}-xnas`, `${base}-xnys`, `${base}-arcx`, `${base}-xase`, `${base}-bats`, `${base}-otcm`];
    }
    return [id, lower];
  }))];
}

// A queue message normally costs three operations (write, read, acknowledgement).
// 1,600 messages leaves room for one retry per message under the 10,000-op free tier.
export const MARKET_QUEUE_MESSAGE_BUDGET = 1_600;
export const MARKET_PROVIDER_CALL_BUDGET = 30_000;
// Keep a large reserve below D1's 100,000-row free allowance for registry
// pulses, claim/run metadata, indexes, and authenticated API fallback traffic.
export const MARKET_D1_WRITE_BUDGET = 60_000;

type SecurityRow = {
  security_id: string;
  display_symbol: string;
  provider_symbol: string;
  exchange_mic: string;
  currency: string;
  venue_code: PublicSecurityDescriptor["venueCode"];
  asset_type: PublicSecurityDescriptor["assetType"];
};

type QuoteRow = { security_id: string; payload_json: string; fetched_at: string };
type PayloadRow = { security_id?: string; payload_json: string; updated_at?: string };
type IntradayRow = { security_id: string; payload_json: string };
type SnapshotSecurityRow = Pick<SecurityRow, "security_id" | "exchange_mic" | "currency">;

export type UsIntradaySessionCoverage = {
  securityId: string;
  currentSessionDate: string;
  currentPoints: number;
  previousSessionDate: string | null;
  previousPoints: number;
  ready: boolean;
};

export function publicSecurityDescriptor(security: RequestedSecurity): PublicSecurityDescriptor {
  const assetType: PublicSecurityDescriptor["assetType"] = security.venueCode === "FUND" || security.venueCode === "USD_FUND"
    ? "fund"
    : security.venueCode === "INDEX"
      ? "index"
      : security.venueCode === "FX"
        ? "fx"
        : security.venueCode === "GLOBAL"
          ? "global"
          : "stock";
  return {
    securityId: security.id,
    displaySymbol: security.displaySymbol,
    providerSymbol: security.providerSymbol,
    exchangeMic: security.exchangeMic,
    currency: security.currency,
    venueCode: security.venueCode,
    assetType,
  };
}

async function executeBatchStatements(db: D1DatabaseLike, statements: D1PreparedStatementLike[], chunkSize = 40) {
  for (let index = 0; index < statements.length; index += chunkSize) {
    const chunk = statements.slice(index, index + chunkSize);
    if (chunk.length) await db.batch(chunk);
  }
}

export function normalizePublicSecurityIds(values: unknown, max = 250) {
  if (!Array.isArray(values)) return [];
  const normalized = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizeRequestedSecurity(value.trim()))
    .filter((value): value is RequestedSecurity => Boolean(value));
  return [...new Map(normalized.map((value) => [value.id, publicSecurityDescriptor(value)])).values()].slice(0, max);
}

export async function reconcileMarketSecurities(db: D1DatabaseLike, securities: PublicSecurityDescriptor[]) {
  // Registry state is shared by every account. Older clients used "reconcile"
  // for their private portfolio subset, which disabled every other user's
  // public symbols and caused the next client to re-enable them. Preserve the
  // wire contract while making that legacy mode safe and additive.
  return mergeMarketSecurities(db, securities);
}

export async function mergeMarketSecurities(db: D1DatabaseLike, securities: PublicSecurityDescriptor[]) {
  if (!securities.length) return 0;
  const now = isoNow();
  const lastSeenCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const statements: D1PreparedStatementLike[] = [];
  for (const security of securities) {
    const variants = canonicalAndExactVariants(security.securityId);
    for (const variantId of variants) {
      statements.push(db.prepare(`
        INSERT INTO market_securities (
          security_id, display_symbol, provider_symbol, exchange_mic, currency, venue_code,
          asset_type, enabled, created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(security_id) DO UPDATE SET
          display_symbol = excluded.display_symbol,
          provider_symbol = excluded.provider_symbol,
          exchange_mic = excluded.exchange_mic,
          currency = excluded.currency,
          venue_code = excluded.venue_code,
          asset_type = excluded.asset_type,
          enabled = 1,
          updated_at = CASE WHEN market_securities.enabled = 0 OR market_securities.display_symbol != excluded.display_symbol THEN excluded.updated_at ELSE market_securities.updated_at END,
          last_seen_at = excluded.last_seen_at
        WHERE market_securities.enabled = 0
          OR market_securities.display_symbol != excluded.display_symbol
          OR market_securities.provider_symbol != excluded.provider_symbol
          OR market_securities.exchange_mic != excluded.exchange_mic
          OR market_securities.currency != excluded.currency
          OR market_securities.venue_code != excluded.venue_code
          OR market_securities.asset_type != excluded.asset_type
          OR market_securities.last_seen_at < ?
      `).bind(
        variantId,
        security.displaySymbol,
        security.providerSymbol,
        security.exchangeMic,
        security.currency,
        security.venueCode,
        security.assetType,
        now,
        now,
        now,
        lastSeenCutoff,
      ));
    }
  }
  await executeBatchStatements(db, statements);
  return securities.length;
}

export async function listEnabledMarketSecurities(db: D1DatabaseLike, seenAfterIso?: string) {
  const statement = db.prepare(`
    SELECT security_id, display_symbol, provider_symbol, exchange_mic, currency, venue_code, asset_type
    FROM market_securities
    WHERE enabled = 1${seenAfterIso ? " AND last_seen_at >= ?" : ""}
    ORDER BY security_id
  `);
  const response = await (seenAfterIso ? statement.bind(seenAfterIso) : statement).all<SecurityRow>();
  return (response.results ?? []).map((row): PublicSecurityDescriptor => ({
    securityId: row.security_id,
    displaySymbol: row.display_symbol,
    providerSymbol: row.provider_symbol,
    exchangeMic: row.exchange_mic,
    currency: row.currency,
    venueCode: row.venue_code,
    assetType: row.asset_type,
  }));
}

export async function readStoredQuotes(db: D1DatabaseLike) {
  const response = await db.prepare("SELECT security_id, payload_json, fetched_at FROM market_quotes").all<QuoteRow>();
  return new Map((response.results ?? []).flatMap((row) => {
    try {
      return [[row.security_id, JSON.parse(row.payload_json) as ServerRemoteQuote] as const];
    } catch {
      return [];
    }
  }));
}

/** Chunk after alias expansion: D1 permits at most 100 bound parameters. */
async function readAliasRows<T>(db: D1DatabaseLike, sql: (placeholders: string) => string, variants: string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < variants.length; offset += 90) {
    const chunk = variants.slice(offset, offset + 90);
    const result = await db.prepare(sql(chunk.map(() => "?").join(","))).bind(...chunk).all<T>();
    if (!result.success) throw new Error("market_storage_read_failed");
    rows.push(...result.results ?? []);
  }
  return rows;
}

export async function readUsIntradayBars(db: D1DatabaseLike, securityIds: string[]) {
  const canonicalIds = [...new Set(securityIds.map(canonicalDomainSecurityId))].slice(0, 20);
  if (!canonicalIds.length) {
    return { bars: [] as IntradayBar[], revision: null as string | null, sessions: [] as UsIntradaySessionCoverage[], missingCurrentSecurityIds: [] as string[] };
  }
  const variants = publicSecurityIdVariants(canonicalIds);
  const [intradayRows, securityRows] = await Promise.all([
    readAliasRows<PayloadRow>(db, (p) => `SELECT security_id, payload_json, updated_at FROM market_intraday WHERE security_id IN (${p})`, variants),
    readAliasRows<SnapshotSecurityRow>(db, (p) => `SELECT security_id, exchange_mic, currency FROM market_securities WHERE security_id IN (${p})`, variants),
  ]);
  const intradayResult = { results: intradayRows };
  const securityResult = { results: securityRows };
  const securityByCanonical = new Map((securityResult.results ?? []).map((security) => [canonicalDomainSecurityId(security.security_id), security]));
  const barsByCanonical = new Map<string, IntradayBar[]>();
  for (const row of intradayResult.results ?? []) {
    try {
      const parsed = JSON.parse(row.payload_json) as IntradayBar[];
      if (!Array.isArray(parsed)) continue;
      const canonical = canonicalDomainSecurityId(row.security_id ?? parsed[0]?.securityId ?? "");
      if (!canonicalIds.includes(canonical)) continue;
      const group = barsByCanonical.get(canonical) ?? [];
      group.push(...parsed.map((bar) => ({ ...bar, securityId: canonical })));
      barsByCanonical.set(canonical, group);
    } catch { /* Corrupt rows are treated as missing and repaired by recovery. */ }
  }
  const sessions: UsIntradaySessionCoverage[] = [];
  const bars: IntradayBar[] = [];
  const missingCurrentSecurityIds: string[] = [];
  for (const securityId of canonicalIds) {
    const security = securityByCanonical.get(securityId);
    const recent = sparkline24HourBars(barsByCanonical.get(securityId) ?? [], {
      now: Date.now(),
      exchangeMic: security?.exchange_mic ?? "XNAS",
      currency: security?.currency ?? "USD",
      country: "US",
    });
    bars.push(...recent);
    const ready = recent.length >= 2;
    if (!ready) missingCurrentSecurityIds.push(securityId);
    sessions.push({ securityId, currentSessionDate: recent.at(-1)?.timestamp.slice(0, 10) ?? "", currentPoints: recent.length, previousSessionDate: "", previousPoints: 0, ready });
  }
  return {
    bars,
    revision: (intradayResult.results ?? []).map((row) => row.updated_at ?? "").sort().at(-1) || null,
    sessions,
    missingCurrentSecurityIds,
  };
}

export async function upsertQuoteBatch(db: D1DatabaseLike, result: MarketQuoteBatchResult) {
  const now = isoNow();
  const retentionCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const barsBySecurity = new Map<string, IntradayBar[]>();
  for (const bar of result.intraday) {
    const bars = barsBySecurity.get(bar.securityId) ?? [];
    bars.push(bar);
    barsBySecurity.set(bar.securityId, bars);
  }
  const requestedVariantIds = [...new Set(result.quotes.flatMap((quote) => canonicalAndExactVariants(quote.securityId)))];
  const existingBarsBySecurity = new Map<string, IntradayBar[]>();
  if (requestedVariantIds.length) {
    const placeholders = requestedVariantIds.map(() => "?").join(", ");
    const stored = await db.prepare(`SELECT security_id, payload_json FROM market_intraday WHERE security_id IN (${placeholders})`)
      .bind(...requestedVariantIds)
      .all<IntradayRow>();
    for (const row of stored.results ?? []) {
      try {
        const bars = JSON.parse(row.payload_json) as IntradayBar[];
        if (Array.isArray(bars)) existingBarsBySecurity.set(row.security_id, bars);
      } catch {
        // A corrupt cached row is replaced by the provider result below.
      }
    }
  }
  const statements: D1PreparedStatementLike[] = [];
  for (const quote of result.quotes) {
    const variants = canonicalAndExactVariants(quote.securityId);
    for (const variantId of variants) {
      const variantQuote = variantId === quote.securityId ? quote : { ...quote, securityId: variantId };
      statements.push(db.prepare(`
        INSERT INTO market_quotes (
          security_id, payload_json, market_timestamp, fetched_at, session, freshness, validation_status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(security_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          market_timestamp = excluded.market_timestamp,
          fetched_at = excluded.fetched_at,
          session = excluded.session,
          freshness = excluded.freshness,
          validation_status = excluded.validation_status,
          updated_at = excluded.updated_at
        WHERE excluded.market_timestamp >= market_quotes.market_timestamp
          AND excluded.fetched_at >= market_quotes.fetched_at
          AND (
            excluded.market_timestamp != market_quotes.market_timestamp
            OR excluded.session != market_quotes.session
            OR excluded.validation_status != market_quotes.validation_status
            OR json_extract(excluded.payload_json, '$.price') IS NOT json_extract(market_quotes.payload_json, '$.price')
            OR json_extract(excluded.payload_json, '$.previousRegularClose') IS NOT json_extract(market_quotes.payload_json, '$.previousRegularClose')
            OR json_extract(excluded.payload_json, '$.priceType') IS NOT json_extract(market_quotes.payload_json, '$.priceType')
          )
      `).bind(
        variantId,
        JSON.stringify(variantQuote),
        quote.marketTimestamp,
        quote.fetchedAt,
        quote.session,
        quote.freshness,
        quote.validationStatus,
        now,
      ));
      const bars = barsBySecurity.get(quote.securityId) ?? [];
      if (bars.length) {
        const incoming = variantId === quote.securityId ? bars : bars.map((bar) => ({ ...bar, securityId: variantId }));
        const merged = new Map<string, IntradayBar>();
        for (const bar of [...(existingBarsBySecurity.get(variantId) ?? []), ...incoming]) {
          const timestamp = Date.parse(bar.timestamp);
          if (!Number.isFinite(timestamp) || timestamp < retentionCutoff || !Number.isFinite(Number(bar.price))) continue;
          merged.set(bar.timestamp, bar);
        }
        const variantBars = sanitizeIntradayBars([...merged.values()]).slice(-250);
        statements.push(db.prepare(`
          INSERT INTO market_intraday (security_id, payload_json, first_timestamp, last_timestamp, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(security_id) DO UPDATE SET
            payload_json = excluded.payload_json,
            first_timestamp = excluded.first_timestamp,
            last_timestamp = excluded.last_timestamp,
            updated_at = excluded.updated_at
          WHERE excluded.payload_json != market_intraday.payload_json
        `).bind(variantId, JSON.stringify(variantBars), variantBars[0]?.timestamp ?? null, variantBars.at(-1)?.timestamp ?? null, now));
      }
    }
  }
  if (statements.length) await executeBatchStatements(db, statements);
  // One provider quote may update quote + intraday rows for exact and
  // canonical IDs. Track that conservative upper bound for admission control.
  await incrementDailyUsage(db, { providerCalls: result.coverage.requested, quoteWrites: result.quotes.length * 4, failures: result.failures.length });
}

export async function upsertHistoryBatch(db: D1DatabaseLike, result: MarketHistoryBatchResult) {
  const now = isoNow();
  const resultSecurityIds = [...new Set([
    ...result.bars.map((bar) => bar.securityId),
  ])];
  // A dividend-only refresh must not load, repair and rewrite decades of price
  // history. Actions and distributions have their own persistence below.
  const cached = await readCachedHistory(db, resultSecurityIds);
  const inspected = inspectMarketHistory(cached.bars, result.bars, [...cached.corporateActions, ...result.corporateActions]);
  const barsBySecurity = new Map<string, MarketBar[]>();
  for (const bar of inspected.bars) {
    const bars = barsBySecurity.get(bar.securityId) ?? [];
    bars.push(bar);
    barsBySecurity.set(bar.securityId, bars);
  }
  const statements = [...barsBySecurity].map(([securityId, bars]) => {
    const ordered = [...bars].sort((a, b) => a.date.localeCompare(b.date));
    return db.prepare(`
      INSERT INTO market_history (security_id, payload_json, first_date, last_date, inception_date, checksum, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(security_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        first_date = excluded.first_date,
        last_date = excluded.last_date,
        inception_date = COALESCE(excluded.inception_date, market_history.inception_date),
        checksum = excluded.checksum,
        updated_at = excluded.updated_at
      WHERE market_history.checksum != excluded.checksum
        OR market_history.last_date != excluded.last_date
        OR market_history.payload_json != excluded.payload_json
    `).bind(securityId, JSON.stringify(ordered), ordered[0]?.date ?? null, ordered.at(-1)?.date ?? null, result.inceptionDates[securityId] ?? cached.inceptionDates[securityId] ?? null, inspected.quality.checksum, now);
  });
  for (const [securityId, inceptionDate] of Object.entries(result.inceptionDates)) {
    if (!barsBySecurity.has(securityId)) statements.push(db.prepare(`
      UPDATE market_history SET inception_date = ?
      WHERE security_id = ? AND inception_date IS NOT ?
    `).bind(inceptionDate, securityId, inceptionDate));
  }
  for (const action of result.corporateActions) {
    statements.push(db.prepare(`
      INSERT INTO market_corporate_actions (action_id, security_id, payload_json, effective_date, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        effective_date = excluded.effective_date,
        updated_at = excluded.updated_at
      WHERE market_corporate_actions.payload_json != excluded.payload_json
        OR market_corporate_actions.effective_date != excluded.effective_date
    `).bind(action.id, action.securityId, JSON.stringify(action), action.effectiveDate, now));
  }
  const sourcePriority = (event: DistributionEvent) => event.confidence === "manual" ? 4 : event.confidence === "official" ? 3 : event.confidence === "reported" ? 2 : 1;
  for (const event of result.distributions) {
    const effectiveDate = (event.exDate ?? event.recordDate ?? event.paymentDate ?? "").slice(0, 10);
    if (!effectiveDate) continue;
    statements.push(db.prepare(`
      INSERT INTO market_distributions (
        event_id, security_id, event_type, effective_date, payment_date, amount_per_unit,
        distribution_unit, currency, source_priority, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        event_type = excluded.event_type,
        effective_date = excluded.effective_date,
        payment_date = excluded.payment_date,
        amount_per_unit = excluded.amount_per_unit,
        distribution_unit = excluded.distribution_unit,
        currency = excluded.currency,
        source_priority = excluded.source_priority,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      WHERE excluded.source_priority > market_distributions.source_priority
        OR (
          excluded.source_priority = market_distributions.source_priority
          AND (
            excluded.event_type != market_distributions.event_type
            OR excluded.effective_date != market_distributions.effective_date
            OR excluded.amount_per_unit != market_distributions.amount_per_unit
            OR excluded.distribution_unit != market_distributions.distribution_unit
            OR excluded.currency != market_distributions.currency
            OR excluded.payment_date IS NOT market_distributions.payment_date
          )
        )
    `).bind(
      event.id,
      event.securityId,
      event.type,
      effectiveDate,
      event.paymentDate?.slice(0, 10) ?? null,
      event.amountPerUnit,
      event.distributionUnit ?? "1",
      event.currency,
      sourcePriority(event),
      JSON.stringify(event),
      now,
    ));
  }
  for (const securityId of result.coveredSecurityIds) {
    const securityBars = result.bars.filter((bar) => bar.securityId === securityId);
    const securityEvents = result.distributions.filter((event) => event.securityId === securityId);
    const coveredFrom = result.requestedFrom;
    const coverageStatus = coveredFrom <= "2000-01-01"
      ? securityEvents.some((event) => Number(event.amountPerUnit) > 0) ? "ready" : "no_events"
      : "partial";
    const sourceProvider = securityEvents[0]?.sourceProvider ?? securityBars[0]?.provider ?? null;
    statements.push(db.prepare(`
      INSERT INTO market_distribution_coverage (
        security_id, covered_from, checked_through, checked_at, event_count, status, source_provider, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(security_id) DO UPDATE SET
        covered_from = CASE WHEN excluded.covered_from < market_distribution_coverage.covered_from THEN excluded.covered_from ELSE market_distribution_coverage.covered_from END,
        checked_through = excluded.checked_through,
        checked_at = excluded.checked_at,
        event_count = CASE WHEN excluded.covered_from <= market_distribution_coverage.covered_from THEN excluded.event_count ELSE market_distribution_coverage.event_count END,
        status = CASE WHEN excluded.covered_from <= market_distribution_coverage.covered_from THEN excluded.status ELSE market_distribution_coverage.status END,
        source_provider = COALESCE(excluded.source_provider, market_distribution_coverage.source_provider),
        updated_at = excluded.updated_at
      WHERE market_distribution_coverage.status != excluded.status
        OR market_distribution_coverage.event_count != excluded.event_count
        OR market_distribution_coverage.covered_from > excluded.covered_from
        OR market_distribution_coverage.checked_through != excluded.checked_through
    `).bind(
      securityId,
      coveredFrom,
      result.generatedAt.slice(0, 10),
      result.generatedAt,
      securityEvents.filter((event) => Number(event.amountPerUnit) > 0).length,
      coverageStatus,
      sourceProvider,
      now,
    ));
  }
  if (statements.length) await executeBatchStatements(db, statements);
  // Indexed tables can charge an additional written row. Conditional no-op
  // statements therefore make this estimate deliberately conservative.
  await incrementDailyUsage(db, { providerCalls: result.coverage.requested, historyWrites: statements.length * 2, failures: result.failures.length });
}

export async function upsertBenchmarks(db: D1DatabaseLike, benchmarks: ServerBenchmark[]) {
  if (!benchmarks.length) return;
  const now = isoNow();
  await executeBatchStatements(db, benchmarks.map((benchmark) => db.prepare(`
    INSERT INTO market_benchmarks (benchmark_id, payload_json, market_timestamp, fetched_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(benchmark_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      market_timestamp = excluded.market_timestamp,
      fetched_at = excluded.fetched_at,
      updated_at = excluded.updated_at
    WHERE excluded.market_timestamp >= market_benchmarks.market_timestamp
      AND excluded.fetched_at >= market_benchmarks.fetched_at
      AND (
        excluded.market_timestamp != market_benchmarks.market_timestamp
        OR json_extract(excluded.payload_json, '$.value') IS NOT json_extract(market_benchmarks.payload_json, '$.value')
        OR json_extract(excluded.payload_json, '$.changeRatio') IS NOT json_extract(market_benchmarks.payload_json, '$.changeRatio')
      )
  `).bind(benchmark.id, JSON.stringify(benchmark), benchmark.marketTimestamp, benchmark.fetchedAt ?? now, now)));
}

function safeJsonRows<T>(rows: PayloadRow[]) {
  return rows.flatMap((row) => {
    try { return [JSON.parse(row.payload_json) as T]; } catch { return []; }
  });
}

export async function readMarketSnapshot(db: D1DatabaseLike, includeIntraday = true): Promise<ServerMarketSnapshot> {
  const securitiesResult = await db.prepare("SELECT security_id, exchange_mic, currency FROM market_securities WHERE enabled = 1").all<SnapshotSecurityRow>();
  const publicIds = new Set((securitiesResult.results ?? []).map(security => canonicalDomainSecurityId(security.security_id)));
  const [quoteResult, benchmarkResult, intradayResult, ptsResult, runResult, usage] = await Promise.all([
    db.prepare(`SELECT q.payload_json FROM market_quotes q JOIN market_securities s ON s.security_id = q.security_id WHERE s.enabled = 1 ORDER BY q.security_id`).all<PayloadRow>(),
    db.prepare("SELECT payload_json FROM market_benchmarks ORDER BY benchmark_id").all<PayloadRow>(),
    includeIntraday
      ? db.prepare(`SELECT i.security_id, i.payload_json, i.updated_at FROM market_intraday i JOIN market_securities s ON s.security_id = i.security_id WHERE s.enabled = 1 ORDER BY i.security_id`).all<PayloadRow>()
      : Promise.resolve({ success: true, results: [] as PayloadRow[] }),
    includeIntraday ? readLatestJapannextPtsBars(db, publicIds) : Promise.resolve({ bars: [] as IntradayBar[], revision: null as string | null }),
    db.prepare("SELECT started_at, status FROM market_refresh_runs ORDER BY started_at DESC LIMIT 1").first<{ started_at: string; status: string }>(),
    readDailyUsage(db),
  ]);
  const decodedQuotes = safeJsonRows<ServerRemoteQuote>(quoteResult.results ?? []);
  const benchmarks = safeJsonRows<ServerBenchmark>(benchmarkResult.results ?? []);
  const securityById = new Map((securitiesResult.results ?? []).map((security) => [security.security_id, security]));
  const securityByCanonicalId = new Map((securitiesResult.results ?? []).map((security) => [canonicalDomainSecurityId(security.security_id), security]));
  const seenCanonicalIntraday = new Set<string>();
  const intraday = (intradayResult.results ?? []).flatMap((row) => {
    try {
      const bars = JSON.parse(row.payload_json) as IntradayBar[];
      const canonical = canonicalDomainSecurityId(row.security_id ?? bars[0]?.securityId ?? "");
      if (seenCanonicalIntraday.has(canonical)) return [];
      seenCanonicalIntraday.add(canonical);
      const security = securityById.get(row.security_id ?? bars[0]?.securityId) ?? securityByCanonicalId.get(canonical);
      return sparkline24HourBars(bars, {
        now: Date.now(),
        exchangeMic: security?.exchange_mic,
        currency: security?.currency,
      });
    } catch {
      return [];
    }
  });
  const intradayRevision = [...(intradayResult.results ?? []).map((row) => row.updated_at ?? ""), ptsResult.revision ?? ""].sort().at(-1) || null;
  const now = Date.now();
  const oldestUsableTimestamp = now - 7 * 24 * 60 * 60 * 1000;
  const rawQuotes = decodedQuotes.filter((quote) => Date.parse(quote.marketTimestamp) >= oldestUsableTimestamp);
  const quotesById = new Map<string, ServerRemoteQuote>();
  for (const quote of rawQuotes) {
    quotesById.set(quote.securityId, quote);
  }
  for (const [secId, quote] of [...quotesById.entries()]) {
    const variants = publicSecurityIdVariants([secId]);
    for (const variant of variants) {
      const existing = quotesById.get(variant);
      if (
        !existing ||
        Date.parse(quote.fetchedAt) > Date.parse(existing.fetchedAt) ||
        Date.parse(quote.marketTimestamp) > Date.parse(existing.marketTimestamp)
      ) {
        quotesById.set(variant, { ...quote, securityId: variant });
      }
    }
  }
  const quotes = [...quotesById.values()];

  // Prefer exchange observations when TSE and daytime PTS have an observation
  // in the same minute. PTS still extends the curve before, after, and through
  // the night session, while gaps remain visible instead of being fabricated.
  const reconciledByMinute = new Map<string, IntradayBar>();
  for (const bar of [...ptsResult.bars, ...intraday]) {
    const canonical = canonicalDomainSecurityId(bar.securityId);
    const minute = bar.timestamp.slice(0, 16);
    reconciledByMinute.set(`${canonical}\u0000${minute}`, { ...bar, securityId: canonical });
  }
  const reconciledGroups = new Map<string, IntradayBar[]>();
  for (const bar of reconciledByMinute.values()) {
    const group = reconciledGroups.get(bar.securityId) ?? [];
    group.push(bar);
    reconciledGroups.set(bar.securityId, group);
  }
  const reconciledIntraday = sanitizeIntradayBars([...reconciledGroups].flatMap(([securityId, bars]) => {
    const security = securityByCanonicalId.get(securityId);
    return sparkline24HourBars(bars, {
      now: Date.now(),
      exchangeMic: security?.exchange_mic,
      currency: security?.currency,
    });
  }));

  const isStale = (quote: ServerRemoteQuote) => {
    const maxAge = quote.venueCode === "FUND" ? 26 * 60 * 60 * 1000 : quote.session === "closed" ? 6 * 60 * 60 * 1000 : 20 * 60 * 1000;
    return quote.freshness === "stale" || now - Date.parse(quote.fetchedAt) > maxAge;
  };
  // Symbol aliases are needed in the payload, but must not inflate coverage.
  const coveredQuotes = [...new Map(quotes.map((quote) => [canonicalDomainSecurityId(quote.securityId), quote])).values()];
  const fresh = coveredQuotes.filter((quote) => !isStale(quote)).length;
  const stale = coveredQuotes.filter(isStale).length;
  const suspect = coveredQuotes.filter((quote) => quote.validationStatus === "suspect").length;
  const savedAt = quotes.map((quote) => quote.fetchedAt).sort().at(-1) ?? null;
  const registered = securityByCanonicalId.size;
  return {
    schemaVersion: 1,
    generatedAt: isoNow(),
    savedAt,
    marketSessions: portfolioMarketSessions("ALL"),
    quotes,
    benchmarks,
    intraday: reconciledIntraday,
    intradayRevision,
    coverage: { registered, quoted: coveredQuotes.length, fresh, stale, suspect },
    refresh: {
      status: !quotes.length ? "empty" : coveredQuotes.length < registered || stale || suspect ? "partial" : "ready",
      lastRunAt: runResult?.started_at ?? null,
      queueMessagesToday: usage.queueMessages,
      providerCallsToday: usage.providerCalls,
    },
  };
}

export async function readCachedHistory(db: D1DatabaseLike, securityIds: string[]) {
  if (!securityIds.length) return { bars: [] as MarketBar[], corporateActions: [] as CorporateAction[], distributions: [] as DistributionEvent[], inceptionDates: {} as Record<string, string>, cachedSecurityIds: [] as string[] };
  const rows: MarketBar[] = [];
  const actions: CorporateAction[] = [];
  const inceptionDates: Record<string, string> = {};
  const cachedSecurityIds: string[] = [];
  for (let index = 0; index < securityIds.length; index += 50) {
    const batch = securityIds.slice(index, index + 50);
    const placeholders = batch.map(() => "?").join(",");
    const response = await db.prepare(`SELECT security_id, payload_json, inception_date FROM market_history WHERE security_id IN (${placeholders})`).bind(...batch).all<{ security_id: string; payload_json: string; inception_date: string | null }>();
    for (const row of response.results ?? []) {
      try {
        rows.push(...JSON.parse(row.payload_json) as MarketBar[]);
        cachedSecurityIds.push(row.security_id);
        if (row.inception_date) inceptionDates[row.security_id] = row.inception_date;
      } catch { /* Ignore corrupt cache rows and let the provider path repair them. */ }
    }
    const idVariants = publicSecurityIdVariants(batch);
    const actionRows = await readAliasRows<PayloadRow>(db, (p) => `SELECT payload_json FROM market_corporate_actions WHERE security_id IN (${p})`, idVariants);
    const actionResponse = { results: actionRows };
    actions.push(...safeJsonRows<CorporateAction>(actionResponse.results ?? []));
  }
  const uniqueActions = [...new Map(actions.map((a) => [a.id, a])).values()];
  return { bars: rows, corporateActions: uniqueActions, distributions: [] as DistributionEvent[], inceptionDates, cachedSecurityIds };
}

export async function readCachedDistributions(db: D1DatabaseLike, securityIds: string[]) {
  if (!securityIds.length) return { distributions: [] as DistributionEvent[], corporateActions: [] as CorporateAction[], coverage: [] as DistributionCoverage[] };
  const variants = publicSecurityIdVariants(securityIds);
  const [eventRows, actionRows, coverageRows] = await Promise.all([
    readAliasRows<PayloadRow>(db, (p) => `SELECT payload_json FROM market_distributions WHERE security_id IN (${p}) ORDER BY effective_date`, variants),
    readAliasRows<PayloadRow>(db, (p) => `SELECT payload_json FROM market_corporate_actions WHERE security_id IN (${p}) ORDER BY effective_date`, variants),
    readAliasRows<{ security_id: string; covered_from: string; checked_through: string; checked_at: string; event_count: number; status: DistributionCoverage["status"]; source_provider: string | null }>(db,
      (p) => `SELECT security_id, covered_from, checked_through, checked_at, event_count, status, source_provider FROM market_distribution_coverage WHERE security_id IN (${p})`, variants),
  ]);
  const eventResponse = { results: eventRows }, actionResponse = { results: actionRows }, coverageResponse = { results: coverageRows };
  const distributions = [...new Map(safeJsonRows<DistributionEvent>(eventResponse.results ?? []).map((event) => [event.id, event])).values()];
  const corporateActions = [...new Map(safeJsonRows<CorporateAction>(actionResponse.results ?? []).map((action) => [action.id, action])).values()];
  const coverage = (coverageResponse.results ?? []).map((row): DistributionCoverage => ({
    securityId: row.security_id,
    coveredFrom: row.covered_from,
    checkedThrough: row.checked_through,
    checkedAt: row.checked_at,
    eventCount: row.event_count,
    status: row.status,
    ...(row.source_provider ? { sourceProvider: row.source_provider } : {}),
  }));
  return { distributions, corporateActions, coverage };
}

export async function listDueHistorySecurityIds(db: D1DatabaseLike, olderThanIso: string) {
  const response = await db.prepare(`
    SELECT s.security_id
    FROM market_securities s
    LEFT JOIN market_history h ON h.security_id = s.security_id
    WHERE s.enabled = 1 AND (h.updated_at IS NULL OR h.updated_at < ?)
    ORDER BY s.security_id
  `).bind(olderThanIso).all<{ security_id: string }>();
  return (response.results ?? []).map((row) => row.security_id);
}

export async function listDueDistributionSecurityIds(db: D1DatabaseLike, olderThanIso: string) {
  const response = await db.prepare(`
    SELECT s.security_id
    FROM market_securities s
    LEFT JOIN market_distribution_coverage d ON d.security_id = s.security_id
    WHERE s.enabled = 1 AND (
      d.checked_at IS NULL OR d.checked_at < ? OR d.status IN ('partial', 'error')
    )
    ORDER BY s.security_id
  `).bind(olderThanIso).all<{ security_id: string }>();
  return (response.results ?? []).map((row) => row.security_id);
}

type UsageIncrement = Partial<{ cronRuns: number; queueMessages: number; providerCalls: number; quoteWrites: number; historyWrites: number; failures: number }>;

export async function incrementDailyUsage(db: D1DatabaseLike, increment: UsageIncrement) {
  const date = isoNow().slice(0, 10);
  const now = isoNow();
  await db.prepare(`
    INSERT INTO market_usage_daily (
      usage_date, cron_runs, queue_messages, provider_calls, quote_writes, history_writes, failures, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(usage_date) DO UPDATE SET
      cron_runs = cron_runs + excluded.cron_runs,
      queue_messages = queue_messages + excluded.queue_messages,
      provider_calls = provider_calls + excluded.provider_calls,
      quote_writes = quote_writes + excluded.quote_writes,
      history_writes = history_writes + excluded.history_writes,
      failures = failures + excluded.failures,
      updated_at = excluded.updated_at
  `).bind(
    date,
    increment.cronRuns ?? 0,
    increment.queueMessages ?? 0,
    increment.providerCalls ?? 0,
    increment.quoteWrites ?? 0,
    increment.historyWrites ?? 0,
    increment.failures ?? 0,
    now,
  ).run();
}

export async function readDailyUsage(db: D1DatabaseLike) {
  const date = isoNow().slice(0, 10);
  const row = await db.prepare(`
    SELECT cron_runs, queue_messages, provider_calls, quote_writes, history_writes, failures
    FROM market_usage_daily WHERE usage_date = ?
  `).bind(date).first<{ cron_runs: number; queue_messages: number; provider_calls: number; quote_writes: number; history_writes: number; failures: number }>();
  return {
    cronRuns: row?.cron_runs ?? 0,
    queueMessages: row?.queue_messages ?? 0,
    providerCalls: row?.provider_calls ?? 0,
    quoteWrites: row?.quote_writes ?? 0,
    historyWrites: row?.history_writes ?? 0,
    failures: row?.failures ?? 0,
  };
}

export async function createRefreshRun(db: D1DatabaseLike, runId: string, scheduledAt: string) {
  const now = isoNow();
  await db.prepare(`
    INSERT OR IGNORE INTO market_refresh_runs (run_id, scheduled_at, started_at, status)
    VALUES (?, ?, ?, 'running')
  `).bind(runId, scheduledAt, now).run();
}

export async function finishRefreshRun(db: D1DatabaseLike, runId: string, requested: number, messages: number, status: "complete" | "budget_limited") {
  await db.prepare(`
    UPDATE market_refresh_runs SET completed_at = ?, requested_count = ?, queue_message_count = ?, status = ? WHERE run_id = ?
  `).bind(isoNow(), requested, messages, status, runId).run();
}

export async function claimRefreshJob(db: D1DatabaseLike, job: MarketRefreshJob) {
  const now = isoNow();
  const staleClaimCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  // The original schema's CHECK constraint predates dedicated distribution
  // jobs. Keep the persisted category compatible; claim_id still distinguishes
  // history and distribution work.
  const storedKind = job.kind === "distributions" ? "history" : job.kind;
  const result = await db.prepare(`
    INSERT INTO market_refresh_claims (claim_id, kind, bucket_at, created_at, status)
    VALUES (?, ?, ?, ?, 'queued')
    ON CONFLICT(claim_id) DO UPDATE SET
      bucket_at = excluded.bucket_at,
      created_at = excluded.created_at,
      completed_at = NULL,
      status = 'queued'
    WHERE market_refresh_claims.status != 'complete' AND market_refresh_claims.created_at < ?
  `).bind(job.claimId, storedKind, job.scheduledAt, now, staleClaimCutoff).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markRefreshJob(db: D1DatabaseLike, claimId: string, status: "running" | "complete" | "partial" | "failed") {
  await db.prepare(`
    UPDATE market_refresh_claims SET status = ?, completed_at = CASE WHEN ? IN ('complete', 'partial', 'failed') THEN ? ELSE completed_at END
    WHERE claim_id = ?
  `).bind(status, status, isoNow(), claimId).run();
}

export async function cleanupRefreshMetadata(db: D1DatabaseLike, olderThanIso: string) {
  await db.batch([
    db.prepare("DELETE FROM market_refresh_claims WHERE created_at < ?").bind(olderThanIso),
    db.prepare("DELETE FROM market_refresh_runs WHERE started_at < ?").bind(olderThanIso),
  ]);
}
