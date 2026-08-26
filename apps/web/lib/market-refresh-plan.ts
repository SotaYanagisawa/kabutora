import type { MarketQuote } from "@kabutora/domain";
import { portfolioMarketSessions } from "./market-session";

export const ACTIVE_QUOTE_REFRESH_MS = 9 * 60 * 1000;
export const CLOSED_QUOTE_REFRESH_MS = 6 * 60 * 60 * 1000;

export type CachedQuote = Pick<MarketQuote, "session" | "fetchedAt">;

export function quoteSessionTransitionTargets(
  securityIds: string[],
  quotes: Record<string, CachedQuote>,
  now = Date.now(),
) {
  const sessions = new Map(portfolioMarketSessions("ALL", new Date(now)).map((status) => [status.market, status.session]));
  return securityIds.filter((securityId) => {
    const quote = quotes[securityId];
    if (!quote) return false;
    const market = /^sec-(?:[0-9]{4}|[0-9]{3}[a-z])-xtks$/iu.test(securityId)
      ? "JP"
      : /^sec-us-/u.test(securityId) ? "US" : null;
    const expectedSession = market ? sessions.get(market) : null;
    return Boolean(expectedSession && expectedSession !== "unknown" && quote.session !== expectedSession);
  });
}

export function quoteRefreshTargets(
  securityIds: string[],
  quotes: Record<string, CachedQuote>,
  options: { force?: boolean; full?: boolean; now?: number } = {},
) {
  if (options.force || options.full) return securityIds;
  const now = options.now ?? Date.now();
  const sessionTransitions = new Set(quoteSessionTransitionTargets(securityIds, quotes, now));
  return securityIds.filter((securityId) => {
    const quote = quotes[securityId];
    if (!quote) return true;
    if (sessionTransitions.has(securityId)) return true;
    const fetchedAt = new Date(quote.fetchedAt).getTime();
    if (!Number.isFinite(fetchedAt)) return true;
    const ttl = quote.session === "closed" ? CLOSED_QUOTE_REFRESH_MS : ACTIVE_QUOTE_REFRESH_MS;
    return now - fetchedAt >= ttl;
  });
}
