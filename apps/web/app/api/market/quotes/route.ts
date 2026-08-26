import { normalizeRequestedSecurities } from "@/lib/market-security";
import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getYahooJapanQuoteBundle, getYahooQuoteBundle } from "@/lib/yahoo-market";
import { portfolioMarketSessions } from "@/lib/market-session";
import { resolveWikidataCompanyAlias } from "@/lib/wikidata-company";
import { getYahooJapanFundQuoteBundle } from "@/lib/yahoo-japan-fund";
import { getMonexForeignFundQuoteBundle } from "@/lib/monex-foreign-fund";
import { tokyoQuoteProviderOrder } from "@/lib/tokyo-quote-provider";
import { stableMarketErrorMessage } from "@/lib/market-api-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

async function getTokyoQuoteBundle(
  providerSymbol: string,
  securityId: string,
  force: boolean,
  intradayRange: "1d" | "5d",
) {
  const session = portfolioMarketSessions("JP")[0]?.session;
  const expectedPtsSession = session === "pts_day" || session === "pts_night" ? session : undefined;
  let lastError: unknown;
  try {
    return await getYahooQuoteBundle(providerSymbol, securityId, "TSE", force, intradayRange, expectedPtsSession);
  } catch (error) {
    lastError = error;
    try {
      return await getYahooJapanQuoteBundle(providerSymbol, securityId, force, expectedPtsSession);
    } catch (fallbackError) {
      throw lastError ?? fallbackError;
    }
  }
}

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const body = await request.json().catch(() => ({})) as { refresh?: unknown; refreshSecurityIds?: unknown; includeIntraday?: unknown; intradayRange?: unknown; securityIds?: unknown };
  const force = body.refresh === true;
  const includeIntraday = body.includeIntraday === true;
  const intradayRange = body.intradayRange === "1d" ? "1d" : "5d";
  const selected = normalizeRequestedSecurities(typeof body.securityIds === "string" ? body.securityIds : null);
  const refreshIds = new Set(normalizeRequestedSecurities(typeof body.refreshSecurityIds === "string" ? body.refreshSecurityIds : null).map((security) => security.id));
  const results = await pooledMap(selected, 4, async (security) => {
    try {
      const securityForce = force || refreshIds.has(security.id);
      let bundle: Awaited<ReturnType<typeof getYahooQuoteBundle>> | Awaited<ReturnType<typeof getYahooJapanFundQuoteBundle>> | Awaited<ReturnType<typeof getMonexForeignFundQuoteBundle>>;
      bundle = security.venueCode === "FUND"
        ? security.id === "sec-foreign-fund-21070062"
          ? await getMonexForeignFundQuoteBundle(security.providerSymbol, security.id, securityForce)
          : await getYahooJapanFundQuoteBundle(security.providerSymbol, security.id, securityForce)
        : security.venueCode === "TSE"
        ? await getTokyoQuoteBundle(security.providerSymbol, security.id, securityForce, intradayRange)
        : await getYahooQuoteBundle(security.providerSymbol, security.id, security.venueCode === "USD_FUND" ? "FUND" : security.venueCode, securityForce, intradayRange);
      const alias = security.venueCode === "US" ? await resolveWikidataCompanyAlias({
        symbol: security.displaySymbol,
        exchangeMic: security.exchangeMic,
        shortName: bundle.shortName,
        longName: bundle.longName,
      }) : null;
      return {
        ok: true as const,
        intraday: bundle.intraday,
        quote: {
          securityId: security.id,
          symbol: security.displaySymbol,
          exchangeMic: security.exchangeMic,
          currency: security.currency,
          ...(bundle.exchangeLabel ? { exchangeLabel: bundle.exchangeLabel } : {}),
          ...(alias ? { brandName: alias.name, brandNameSource: alias.source } : {}),
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

  const quotes = results.flatMap((result) => (result.ok ? [result.quote] : []));
  const intraday = includeIntraday ? results.flatMap((result) => (result.ok ? result.intraday : [])) : [];
  const failures = results.flatMap((result) => (result.ok ? [] : [result.failure]));
  const fresh = quotes.filter((quote) => quote.freshness === "live" || quote.freshness === "near_live").length;
  const stale = quotes.filter((quote) => quote.freshness === "stale").length;
  const suspect = quotes.filter((quote) => quote.validationStatus === "suspect").length;
  const generatedAt = new Date().toISOString();
  return Response.json(
    {
      generatedAt,
      marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)),
      quotes,
      intraday,
      failures,
      coverage: { requested: selected.length, returned: quotes.length, fresh, stale, suspect },
      provider: { primary: "yahoo_and_monex_unofficial", status: failures.length || suspect ? (quotes.length ? "partial" : "unavailable") : "ok" },
    },
    { status: quotes.length || selected.length === 0 ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
