import { normalizeRequestedSecurities } from "./market-security";
import { getYahooJapanQuoteBundle, getYahooHistory, getYahooQuoteBundle, tokyoMarketTimestamp } from "./yahoo-market";
import { portfolioMarketSessions } from "./market-session";
import { getYahooJapanFundDistributions, getYahooJapanFundHistory, getYahooJapanFundQuoteBundle } from "./yahoo-japan-fund";
import { getMonexForeignFundHistory, getMonexForeignFundQuoteBundle } from "./monex-foreign-fund";
import { inspectMarketHistory } from "./market-history";
import { stableMarketErrorMessage } from "./market-api-response";
import { fetchCnbcBatchQuotes, fetchCnbcQuote } from "./cnbc-quote-provider";
import { fetchYahooBatchQuotes, normalizeBatchQuote } from "./yahoo-batch-quote";
import type { IntradayBar, MarketQuote } from "@kabutora/domain";
import type {
  MarketHistoryBatchResult,
  MarketQuoteBatchResult,
  ServerBenchmark,
} from "./server-market-types";

async function pooledMap<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>) {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        result[index] = await task(items[index]);
      }
    }),
  );
  return result;
}

export type QuoteBundle = {
  quote: MarketQuote;
  intraday: IntradayBar[];
  exchangeLabel?: string;
  shortName?: string;
  longName?: string;
};

export async function getTokyoQuoteBundle(
  providerSymbol: string,
  securityId: string,
  force: boolean,
  intradayRange: "1d" | "5d",
): Promise<QuoteBundle> {
  const session = portfolioMarketSessions("JP")[0]?.session;
  const expectedPtsSession = session === "pts_day" || session === "pts_night" ? session : undefined;
  let lastError: unknown;
  try {
    const bundle = await getYahooQuoteBundle(providerSymbol, securityId, "TSE", force, intradayRange, expectedPtsSession);
    if (bundle.quote.validationStatus !== "suspect") {
      return bundle;
    }
    try {
      const japanBundle = await getYahooJapanQuoteBundle(providerSymbol, securityId, force, expectedPtsSession);
      if (japanBundle.quote.validationStatus !== "suspect") {
        return japanBundle;
      }
    } catch {}
    return bundle;
  } catch (error) {
    lastError = error;
    try {
      return await getYahooJapanQuoteBundle(providerSymbol, securityId, force, expectedPtsSession);
    } catch (fallbackError) {
      throw lastError ?? fallbackError;
    }
  }
}

export async function getUsQuoteBundleWithFallback(
  providerSymbol: string,
  securityId: string,
  venueCode: string,
  force: boolean,
  intradayRange: "1d" | "5d" = "5d",
): Promise<QuoteBundle> {
  let primaryBundle: QuoteBundle | null = null;
  let primaryError: unknown;
  try {
    primaryBundle = await getYahooQuoteBundle(
      providerSymbol,
      securityId,
      venueCode === "USD_FUND" ? "FUND" : venueCode,
      force,
      intradayRange,
    );
    if (primaryBundle.quote.validationStatus !== "suspect" && primaryBundle.quote.freshness !== "stale") {
      return primaryBundle;
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    const cnbcResult = await fetchCnbcQuote(providerSymbol, securityId, venueCode);
    if (cnbcResult.quote.validationStatus !== "suspect" || !primaryBundle) {
      const fallbackObservation: IntradayBar = {
        securityId,
        timestamp: cnbcResult.quote.marketTimestamp,
        price: cnbcResult.quote.price,
        session: cnbcResult.quote.session,
        provider: cnbcResult.quote.provider,
      };

      const mergedBars = new Map<string, IntradayBar>();
      for (const bar of primaryBundle?.intraday ?? []) {
        if (Number.isFinite(Date.parse(bar.timestamp)) && Number.isFinite(Number(bar.price))) {
          mergedBars.set(`${bar.securityId ?? securityId}\u0000${bar.timestamp}`, bar);
        }
      }
      mergedBars.set(`${securityId}\u0000${fallbackObservation.timestamp}`, fallbackObservation);
      const mergedIntraday = [...mergedBars.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      const primaryTimestamp = Date.parse(primaryBundle?.quote.marketTimestamp ?? "");
      const fallbackTimestamp = Date.parse(cnbcResult.quote.marketTimestamp);
      const primaryIsStale = !primaryBundle || primaryBundle.quote.freshness === "stale" || primaryBundle.quote.validationStatus === "suspect";

      const usePrimaryQuote = !primaryIsStale && Number.isFinite(primaryTimestamp) && primaryTimestamp > fallbackTimestamp;
      const quoteToReturn = usePrimaryQuote ? primaryBundle!.quote : cnbcResult.quote;

      return {
        quote: quoteToReturn,
        intraday: mergedIntraday,
        ...(cnbcResult.shortName ? { shortName: cnbcResult.shortName } : primaryBundle?.shortName ? { shortName: primaryBundle.shortName } : {}),
        ...(cnbcResult.longName ? { longName: cnbcResult.longName } : primaryBundle?.longName ? { longName: primaryBundle.longName } : {}),
        ...(cnbcResult.exchangeLabel ? { exchangeLabel: cnbcResult.exchangeLabel } : primaryBundle?.exchangeLabel ? { exchangeLabel: primaryBundle.exchangeLabel } : {}),
      };
    }
  } catch {
    // Secondary fallback error: if primary had a suspect/stale bundle, return it; otherwise throw primaryError
  }

  if (primaryBundle) return primaryBundle;
  throw primaryError ?? new Error(`市場価格を取得できませんでした: ${providerSymbol}`);
}

export async function fetchMarketQuoteBatch(
  securityIds: string[],
  options: { force?: boolean; forceSecurityIds?: Set<string>; includeIntraday?: boolean; intradayRange?: "1d" | "5d"; concurrency?: number } = {},
): Promise<MarketQuoteBatchResult> {
  const selected = normalizeRequestedSecurities(securityIds.join(","), Math.min(250, securityIds.length));
  const force = options.force === true;
  const intradayRange = options.intradayRange === "5d" ? "5d" : "1d";
  const includeIntraday = options.includeIntraday !== false;

  // Fast-path: When intraday bars are not required, fetch all batchable securities in one HTTP request
  if (!includeIntraday) {
    const batchable = selected.filter(
      (s) => s.venueCode !== "FUND" && s.venueCode !== "TSE" && s.id !== "sec-foreign-fund-21070062",
    );
    const nonBatchable = selected.filter(
      (s) => s.venueCode === "FUND" || s.venueCode === "TSE" || s.id === "sec-foreign-fund-21070062",
    );

    const batchSymbols = batchable.map((s) => s.providerSymbol);
    const [batchRawMap, nonBatchResults] = await Promise.all([
      fetchYahooBatchQuotes(batchSymbols).catch(() => new Map()),
      pooledMap(nonBatchable, Math.max(1, Math.min(6, options.concurrency ?? 6)), async (security) => {
        try {
          const securityForce = force || options.forceSecurityIds?.has(security.id) === true;
          let bundle: QuoteBundle;
          if (security.venueCode === "TSE") {
            bundle = await getTokyoQuoteBundle(security.providerSymbol, security.id, securityForce, intradayRange);
          } else if (security.id === "sec-foreign-fund-21070062") {
            bundle = await getMonexForeignFundQuoteBundle(security.providerSymbol, security.id, securityForce);
          } else {
            bundle = await getYahooJapanFundQuoteBundle(security.providerSymbol, security.id, securityForce);
          }
          return {
            ok: true as const,
            intraday: [],
            quote: {
              securityId: security.id,
              symbol: security.displaySymbol,
              exchangeMic: security.exchangeMic,
              currency: security.currency,
              ...(bundle.exchangeLabel ? { exchangeLabel: bundle.exchangeLabel } : {}),
              ...(bundle.shortName ? { shortName: bundle.shortName } : {}),
              ...(bundle.longName ? { longName: bundle.longName } : {}),
              ...bundle.quote,
            },
          };
        } catch (error) {
          return {
            ok: false as const,
            failure: {
              securityId: security.id,
              symbol: security.displaySymbol,
              message: stableMarketErrorMessage(error, "市場価格を取得できませんでした"),
            },
          };
        }
      }),
    ]);

    const batchResults = batchable.map((security) => {
      const raw = batchRawMap.get(security.providerSymbol.toUpperCase());
      const normalized = raw ? normalizeBatchQuote(raw, security.venueCode) : null;
      if (normalized && normalized.quote.validationStatus !== "suspect") {
        return {
          ok: true as const,
          intraday: [],
          quote: {
            securityId: security.id,
            symbol: security.displaySymbol,
            exchangeMic: security.exchangeMic,
            currency: security.currency,
            ...(normalized.exchangeLabel ? { exchangeLabel: normalized.exchangeLabel } : {}),
            ...(normalized.shortName ? { shortName: normalized.shortName } : {}),
            ...(normalized.longName ? { longName: normalized.longName } : {}),
            ...normalized.quote,
          },
        };
      }
      return null;
    });

    const failedBatchSecurities = batchable.filter((_, idx) => !batchResults[idx]);
    const fallbackResults = failedBatchSecurities.length > 0
      ? await pooledMap(failedBatchSecurities, Math.max(1, Math.min(6, options.concurrency ?? 6)), async (security) => {
          try {
            const securityForce = force || options.forceSecurityIds?.has(security.id) === true;
            const bundle = security.venueCode === "TSE"
              ? await getTokyoQuoteBundle(security.providerSymbol, security.id, securityForce, intradayRange)
              : await getUsQuoteBundleWithFallback(security.providerSymbol, security.id, security.venueCode, securityForce, intradayRange);
            return {
              ok: true as const,
              intraday: [],
              quote: {
                securityId: security.id,
                symbol: security.displaySymbol,
                exchangeMic: security.exchangeMic,
                currency: security.currency,
                ...(bundle.exchangeLabel ? { exchangeLabel: bundle.exchangeLabel } : {}),
                ...(bundle.shortName ? { shortName: bundle.shortName } : {}),
                ...(bundle.longName ? { longName: bundle.longName } : {}),
                ...bundle.quote,
              },
            };
          } catch (error) {
            return {
              ok: false as const,
              failure: {
                securityId: security.id,
                symbol: security.displaySymbol,
                message: stableMarketErrorMessage(error, "市場価格を取得できませんでした"),
              },
            };
          }
        })
      : [];

    const successfulBatchResults = batchResults.filter((r): r is NonNullable<typeof r> => Boolean(r));
    const allResults = [...successfulBatchResults, ...fallbackResults, ...nonBatchResults];
    const quotes = allResults.flatMap((r) => (r.ok ? [r.quote] : []));
    const failures = allResults.flatMap((r) => (r.ok ? [] : [r.failure]));
    const generatedAt = new Date().toISOString();

    return {
      generatedAt,
      marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)),
      quotes,
      intraday: [],
      failures,
      coverage: {
        requested: selected.length,
        returned: quotes.length,
        fresh: quotes.filter((quote) => quote.freshness === "live" || quote.freshness === "near_live").length,
        stale: quotes.filter((quote) => quote.freshness === "stale").length,
        suspect: quotes.filter((quote) => quote.validationStatus === "suspect").length,
      },
    };
  }

  const results = await pooledMap(selected, Math.max(1, Math.min(8, options.concurrency ?? 8)), async (security) => {
    try {
      const securityForce = force || options.forceSecurityIds?.has(security.id) === true;
      let bundle: QuoteBundle;
      if (security.venueCode === "FUND") {
        bundle = security.id === "sec-foreign-fund-21070062"
          ? await getMonexForeignFundQuoteBundle(security.providerSymbol, security.id, securityForce)
          : await getYahooJapanFundQuoteBundle(security.providerSymbol, security.id, securityForce);
      } else if (security.venueCode === "TSE") {
        bundle = await getTokyoQuoteBundle(security.providerSymbol, security.id, securityForce, intradayRange);
      } else if (security.id === "sec-fx-usdjpy" || security.venueCode === "FX") {
        try {
          bundle = await getYahooQuoteBundle(security.providerSymbol, security.id, security.venueCode, securityForce, intradayRange);
        } catch {
          const yj = await getUsdJpyFromYahooJapan(securityForce);
          const price = String(yj.value);
          const previousClose = yj.changeRatio != null && 1 + yj.changeRatio > 0 ? String(yj.value / (1 + yj.changeRatio)) : undefined;
          bundle = {
            quote: {
              price,
              ...(previousClose ? { previousRegularClose: previousClose } : {}),
              marketTimestamp: yj.marketTimestamp,
              fetchedAt: new Date().toISOString(),
              freshness: yj.freshness,
              provider: "yahoo_japan_fx_html:fallback",
              session: "regular",
              priceType: "last_trade",
              venueCode: "FX",
              validationStatus: "valid",
            },
            intraday: [],
            exchangeLabel: "FX",
            shortName: "USD/JPY",
          };
        }
      } else {
        bundle = await getUsQuoteBundleWithFallback(
          security.providerSymbol,
          security.id,
          security.venueCode === "USD_FUND" ? "FUND" : security.venueCode,
          securityForce,
          options.intradayRange ?? "5d",
        );
      }
      return {
        ok: true as const,
        intraday: bundle.intraday,
        quote: {
          securityId: security.id,
          symbol: security.displaySymbol,
          exchangeMic: security.exchangeMic,
          currency: security.currency,
          ...(bundle.exchangeLabel ? { exchangeLabel: bundle.exchangeLabel } : {}),
          ...(bundle.shortName ? { shortName: bundle.shortName } : {}),
          ...(bundle.longName ? { longName: bundle.longName } : {}),
          ...bundle.quote,
        },
      };
    } catch (error) {
      return {
        ok: false as const,
        failure: {
          securityId: security.id,
          symbol: security.displaySymbol,
          message: stableMarketErrorMessage(error, "市場価格を取得できませんでした"),
        },
      };
    }
  });
  const quotes = results.flatMap((result) => result.ok ? [result.quote] : []);
  const intraday = options.includeIntraday === false ? [] : results.flatMap((result) => result.ok ? result.intraday : []);
  const failures = results.flatMap((result) => result.ok ? [] : [result.failure]);
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)),
    quotes,
    intraday,
    failures,
    coverage: {
      requested: selected.length,
      returned: quotes.length,
      fresh: quotes.filter((quote) => quote.freshness === "live" || quote.freshness === "near_live").length,
      stale: quotes.filter((quote) => quote.freshness === "stale").length,
      suspect: quotes.filter((quote) => quote.validationStatus === "suspect").length,
    },
  };
}

export async function fetchMarketHistoryBatch(
  securityIds: string[],
  options: { from?: string; force?: boolean; distributionsOnly?: boolean } = {},
): Promise<MarketHistoryBatchResult> {
  const selected = normalizeRequestedSecurities(securityIds.join(","), Math.min(250, securityIds.length));
  const validFrom = options.from && /^20\d{2}-\d{2}-\d{2}$/u.test(options.from) ? options.from : null;
  const start = validFrom ? new Date(`${validFrom}T00:00:00+09:00`) : new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const requestedFrom = validFrom ?? start.toISOString().slice(0, 10);
  start.setUTCDate(start.getUTCDate() - 7);
  const period1 = Math.floor(start.getTime() / 1000);
  const stableEnd = new Date();
  stableEnd.setUTCHours(0, 0, 0, 0);
  stableEnd.setUTCDate(stableEnd.getUTCDate() + 2);
  const period2 = Math.floor(stableEnd.getTime() / 1000);
  const results = await pooledMap(selected, 3, async (security) => {
    try {
      const history = options.distributionsOnly
        ? security.venueCode === "FUND"
          ? security.id === "sec-foreign-fund-21070062"
            ? { bars: [], corporateActions: [], distributions: [] }
            : { bars: [], corporateActions: [], distributions: await getYahooJapanFundDistributions(security.providerSymbol, security.id, options.force === true) }
          : await getYahooHistory(security.providerSymbol, security.id, period1, period2, options.force === true, true)
        : security.venueCode === "FUND"
          ? security.id === "sec-foreign-fund-21070062"
            ? await getMonexForeignFundHistory(security.providerSymbol, security.id, period1, period2, options.force === true)
            : await getYahooJapanFundHistory(security.providerSymbol, security.id, period1, period2, options.force === true)
          : await getYahooHistory(security.providerSymbol, security.id, period1, period2, options.force === true);
      return { ok: true as const, securityId: security.id, ...history };
    } catch (error) {
      return {
        ok: false as const,
        failure: {
          securityId: security.id,
          symbol: security.displaySymbol,
          message: stableMarketErrorMessage(error, "市場履歴を取得できませんでした"),
        },
      };
    }
  });
  const successes = results.filter((result) => result.ok);
  const inspected = inspectMarketHistory([], successes.flatMap((result) => result.bars), successes.flatMap((result) => result.corporateActions));
  const distributions = [...new Map(successes.flatMap((result) => "distributions" in result && Array.isArray(result.distributions) ? result.distributions : []).map((event) => [event.id, event])).values()]
    .sort((left, right) => (left.exDate ?? left.recordDate ?? left.paymentDate ?? "").localeCompare(right.exDate ?? right.recordDate ?? right.paymentDate ?? ""));
  const failures = results.flatMap((result) => result.ok ? [] : [result.failure]);
  const inceptionDates = Object.fromEntries(successes.flatMap((result) => "inceptionDate" in result && result.inceptionDate ? [[result.securityId, result.inceptionDate]] : []));
  const generatedAt = new Date().toISOString();
  return {
    generatedAt,
    requestedFrom,
    marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)),
    bars: inspected.bars,
    corporateActions: inspected.actions,
    distributions,
    inceptionDates,
    quality: inspected.quality,
    failures,
    coverage: { requested: selected.length, returned: successes.length },
    coveredSecurityIds: successes.map((result) => result.securityId),
  };
}

const BENCHMARKS = [
  { id: "usd-jpy", label: "USD/JPY", symbol: "JPY=X", venue: "FX" },
  { id: "cny-jpy", label: "CNY/JPY", symbol: "CNYJPY=X", venue: "FX" },
  { id: "sp500", label: "S&P 500", symbol: "^GSPC", venue: "US" },
  { id: "nasdaq", label: "NASDAQ", symbol: "^IXIC", venue: "US" },
  { id: "dow", label: "Dow", symbol: "^DJI", venue: "US" },
  { id: "nikkei225", label: "日経225", symbol: "^N225", venue: "TSE" },
  { id: "topix", label: "TOPIX", symbol: "998405.T", venue: "TSE" },
] as const;

async function fetchTopixFromYahooJapan() {
  const response = await fetch("https://finance.yahoo.co.jp/quote/998405.T", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Kabutora/1.0)" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`TOPIX: Yahoo Japan returned ${response.status}`);
  const html = await response.text();
  const marker = html.indexOf('"mainDomesticIndexPriceBoard"');
  if (marker < 0) throw new Error("TOPIX: price board unavailable");
  const board = html.slice(marker, marker + 2_600);
  const field = (name: string) => new RegExp(`"${name}":"([^"]*)"`).exec(board)?.[1] ?? "";
  const value = Number(field("price").replaceAll(",", ""));
  const changeRatio = Number(field("changePriceRate")) / 100;
  if (!Number.isFinite(value) || value <= 0) throw new Error("TOPIX: invalid price");
  const updateTime = field("japanUpdateTime");
  const marketTimestamp = tokyoMarketTimestamp(updateTime);
  return { value, changeRatio: Number.isFinite(changeRatio) ? changeRatio : null, marketTimestamp, freshness: "delayed" as const };
}

let topixCache: { value: Awaited<ReturnType<typeof fetchTopixFromYahooJapan>>; expiresAt: number; staleUntil: number } | null = null;

async function getTopixFromYahooJapan(force: boolean) {
  if (!force && topixCache && topixCache.expiresAt > Date.now()) return topixCache.value;
  try {
    const value = await fetchTopixFromYahooJapan();
    topixCache = { value, expiresAt: Date.now() + 15 * 60 * 1000, staleUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 };
    return value;
  } catch (error) {
    if (topixCache && topixCache.staleUntil > Date.now()) return { ...topixCache.value, freshness: "cached" as const };
    throw error;
  }
}

async function fetchUsdJpyFromYahooJapan() {
  const response = await fetch("https://finance.yahoo.co.jp/quote/USDJPY=FX", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Kabutora/1.0)" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`USD/JPY: Yahoo Japan returned ${response.status}`);
  const html = await response.text();
  const match = html.match(/\"name\":\"米ドル\/円\",\"bid\":\{\"value\":\"([0-9.]+)\"\},\"ask\":\{\"value\":\"([0-9.]+)\"\},\"change\":\{\"value\":\"([0-9.-]+)\"\}/)
    || html.match(/\\\"name\\\":\\\"米ドル\/円\\\",\\\"bid\\\":\{\\\"value\\\":\\\"([0-9.]+)\\\"\},\\\"ask\\\":\{\\\"value\\\":\\\"([0-9.]+)\\\"\},\\\"change\\\":\{\\\"value\\\":\\\"([0-9.-]+)\\\"\}/);
  if (!match) throw new Error("USD/JPY: rate unavailable on Yahoo Japan");
  const bid = Number(match[1]);
  const ask = Number(match[2]);
  const change = Number(match[3]);
  const value = Number(((bid + ask) / 2).toFixed(3));
  if (!Number.isFinite(value) || value < 50 || value > 300) throw new Error("USD/JPY: invalid rate");
  const previous = value - change;
  const changeRatio = previous > 0 ? (value / previous) - 1 : null;
  return { value, changeRatio: Number.isFinite(changeRatio) ? changeRatio : null, marketTimestamp: new Date().toISOString(), freshness: "delayed" as const };
}

let usdJpyCache: { value: Awaited<ReturnType<typeof fetchUsdJpyFromYahooJapan>>; expiresAt: number; staleUntil: number } | null = null;

async function getUsdJpyFromYahooJapan(force: boolean) {
  if (!force && usdJpyCache && usdJpyCache.expiresAt > Date.now()) return usdJpyCache.value;
  try {
    const value = await fetchUsdJpyFromYahooJapan();
    usdJpyCache = { value, expiresAt: Date.now() + 15 * 60 * 1000, staleUntil: Date.now() + 7 * 24 * 60 * 60 * 1000 };
    return value;
  } catch (error) {
    if (usdJpyCache && usdJpyCache.staleUntil > Date.now()) return { ...usdJpyCache.value, freshness: "cached" as const };
    throw error;
  }
}

export async function fetchMarketBenchmarks(force = false) {
  const results = await Promise.all(BENCHMARKS.map(async (benchmark) => {
    try {
      if (benchmark.id === "topix") {
        const fetchedAt = new Date().toISOString();
        return { ok: true as const, benchmark: { ...benchmark, ...(await getTopixFromYahooJapan(force)), fetchedAt } satisfies ServerBenchmark };
      }
      if (benchmark.id === "usd-jpy") {
        try {
          const { quote } = await getYahooQuoteBundle(benchmark.symbol, `benchmark-${benchmark.id}`, benchmark.venue, force);
          const previous = quote.previousRegularClose == null ? null : Number(quote.previousRegularClose);
          const value = Number(quote.price);
          if (value >= 50 && value <= 300) {
            const fetchedAt = new Date().toISOString();
            return {
              ok: true as const,
              benchmark: {
                ...benchmark,
                value,
                changeRatio: previous && previous > 0 ? value / previous - 1 : null,
                marketTimestamp: quote.marketTimestamp,
                freshness: quote.freshness,
                fetchedAt,
              } satisfies ServerBenchmark,
            };
          }
        } catch {
          // fall through to Yahoo Japan
        }
        const fetchedAt = new Date().toISOString();
        const yjResult = await getUsdJpyFromYahooJapan(force);
        return { ok: true as const, benchmark: { ...benchmark, ...yjResult, fetchedAt } satisfies ServerBenchmark };
      }
      let quote: MarketQuote;
      try {
        const bundle = await getYahooQuoteBundle(benchmark.symbol, `benchmark-${benchmark.id}`, benchmark.venue, force);
        quote = bundle.quote;
      } catch (error) {
        if (benchmark.venue === "US") {
          const cnbcResult = await fetchCnbcQuote(benchmark.symbol, `benchmark-${benchmark.id}`, benchmark.venue);
          quote = cnbcResult.quote;
        } else {
          throw error;
        }
      }
      const previous = quote.previousRegularClose == null ? null : Number(quote.previousRegularClose);
      const value = Number(quote.price);
      const fetchedAt = new Date().toISOString();
      return {
        ok: true as const,
        benchmark: {
          ...benchmark,
          value,
          changeRatio: previous && previous > 0 ? value / previous - 1 : null,
          marketTimestamp: quote.marketTimestamp,
          freshness: quote.freshness,
          fetchedAt,
        } satisfies ServerBenchmark,
      };
    } catch (error) {
      return { ok: false as const, failure: { id: benchmark.id, message: stableMarketErrorMessage(error, "市場指標を取得できませんでした") } };
    }
  }));
  return {
    generatedAt: new Date().toISOString(),
    marketSessions: portfolioMarketSessions("ALL"),
    benchmarks: results.flatMap((result) => result.ok ? [result.benchmark] : []),
    failures: results.flatMap((result) => result.ok ? [] : [result.failure]),
  };
}
