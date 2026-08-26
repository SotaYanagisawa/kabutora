import { normalizeRequestedSecurities } from "@/lib/market-security";
import { inspectMarketHistory } from "@/lib/market-history";
import { authorizeMarketRequest, unauthorizedResponse } from "@/lib/server-auth";
import { getYahooHistory } from "@/lib/yahoo-market";
import { portfolioMarketSessions } from "@/lib/market-session";
import { getYahooJapanFundHistory } from "@/lib/yahoo-japan-fund";
import { getMonexForeignFundHistory } from "@/lib/monex-foreign-fund";
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

export async function POST(request: Request) {
  try { await authorizeMarketRequest(request); } catch { return unauthorizedResponse(); }
  const body = await request.json().catch(() => ({})) as { refresh?: unknown; securityIds?: unknown; from?: unknown };
  const force = body.refresh === true;
  const selected = normalizeRequestedSecurities(typeof body.securityIds === "string" ? body.securityIds : null);
  const requestedFrom = typeof body.from === "string" ? body.from : null;
  const validFrom = requestedFrom && /^20\d{2}-\d{2}-\d{2}$/u.test(requestedFrom) ? requestedFrom : null;
  const start = validFrom ? new Date(`${validFrom}T00:00:00+09:00`) : new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  start.setUTCDate(start.getUTCDate() - 7);
  const period1 = Math.floor(start.getTime() / 1000);
  const stableEnd = new Date();
  stableEnd.setUTCHours(0, 0, 0, 0);
  stableEnd.setUTCDate(stableEnd.getUTCDate() + 2);
  const period2 = Math.floor(stableEnd.getTime() / 1000);

  const results = await pooledMap(selected, 3, async (security) => {
    try {
      const history = security.venueCode === "FUND"
        ? security.id === "sec-foreign-fund-21070062"
          ? await getMonexForeignFundHistory(security.providerSymbol, security.id, period1, period2, force)
          : await getYahooJapanFundHistory(security.providerSymbol, security.id, period1, period2, force)
        : await getYahooHistory(security.providerSymbol, security.id, period1, period2, force);
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
  const bars = inspected.bars;
  const corporateActions = inspected.actions;
  const inceptionDates = Object.fromEntries(successes.flatMap((result) => "inceptionDate" in result && result.inceptionDate ? [[result.securityId, result.inceptionDate]] : []));
  const failures = results.flatMap((result) => (result.ok ? [] : [result.failure]));
  const generatedAt = new Date().toISOString();
  return Response.json(
    {
      generatedAt,
      marketSessions: portfolioMarketSessions("ALL", new Date(generatedAt)),
      period: { from: new Date(period1 * 1000).toISOString(), to: new Date(period2 * 1000).toISOString() },
      bars,
      corporateActions,
      inceptionDates,
      quality: inspected.quality,
      failures,
      coverage: { requested: selected.length, returned: successes.length },
      provider: { primary: "yahoo_and_monex_unofficial", status: failures.length ? (successes.length ? "partial" : "unavailable") : "ok" },
    },
    { status: successes.length || selected.length === 0 ? 200 : 503, headers: { "Cache-Control": "private, no-store", "X-History-Checksum": inspected.quality.checksum } },
  );
}
