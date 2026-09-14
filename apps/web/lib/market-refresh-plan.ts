import { domainSecurityIdVariants, type MarketQuote } from "@kabutora/domain";
import { portfolioMarketSessions } from "./market-session";

export const ACTIVE_QUOTE_REFRESH_MS = 10 * 60 * 1000;
export const CLOSED_QUOTE_REFRESH_MS = 6 * 60 * 60 * 1000;

export type CachedQuote = Pick<MarketQuote, "session" | "fetchedAt"> & Partial<Pick<MarketQuote, "marketTimestamp" | "venueCode">>;

export function findCachedQuote(quotes: Record<string, CachedQuote>, securityId: string): CachedQuote | undefined {
  if (quotes[securityId]) return quotes[securityId];
  for (const variant of domainSecurityIdVariants(securityId)) {
    if (quotes[variant]) return quotes[variant];
  }
  return undefined;
}

export function isNonIntradaySecurity(securityId: string, quote?: CachedQuote): boolean {
  if (quote?.venueCode === "FUND" || quote?.venueCode === "FX") return true;
  if (securityId === "sec-fx-usdjpy" || securityId.startsWith("sec-fx-")) return true;
  if (securityId.startsWith("sec-jp-fund-") || securityId.startsWith("sec-foreign-fund-") || securityId.startsWith("sec-fund-")) return true;
  return false;
}

export function quoteSessionTransitionTargets(
  securityIds: string[],
  quotes: Record<string, CachedQuote>,
  now = Date.now(),
) {
  const sessions = new Map(portfolioMarketSessions("ALL", new Date(now)).map((status) => [status.market, status.session]));
  return securityIds.filter((securityId) => {
    const quote = findCachedQuote(quotes, securityId);
    if (!quote) return false;
    const market = /^sec-(?:[0-9]{4}|[0-9]{3}[a-z])(?:-(?:xtks|tse))?$/iu.test(securityId)
      ? "JP"
      : /^sec-us-/u.test(securityId) ? "US" : null;
    const expectedSession = market ? sessions.get(market) : null;
    return Boolean(expectedSession && expectedSession !== "unknown" && quote.session !== expectedSession);
  });
}

export function quoteRefreshTargets(
  securityIds: string[],
  quotes: Record<string, CachedQuote>,
  options: { force?: boolean; full?: boolean; now?: number; hasIntraday?: (securityId: string) => boolean } = {},
) {
  if (options.force || options.full) return securityIds;
  const now = options.now ?? Date.now();
  const sessionTransitions = new Set(quoteSessionTransitionTargets(securityIds, quotes, now));
  return securityIds.filter((securityId) => {
    const quote = findCachedQuote(quotes, securityId);
    if (!quote) return true;
    const fetchedAt = new Date(quote.fetchedAt).getTime();
    if (!Number.isFinite(fetchedAt)) return true;
    const age = now - fetchedAt;

    // Minimum throttle: A quote fetched less than 15 seconds ago was just received
    // and must never be refetched immediately in a tight loop.
    if (age < 15_000) return false;

    if (sessionTransitions.has(securityId)) return true;

    const ttl = quote.session === "closed" ? CLOSED_QUOTE_REFRESH_MS : ACTIVE_QUOTE_REFRESH_MS;
    if (age >= ttl) return true;

    if (options.hasIntraday && !options.hasIntraday(securityId)) {
      if (isNonIntradaySecurity(securityId, quote)) return false;
      return age >= ACTIVE_QUOTE_REFRESH_MS;
    }
    return false;
  });
}
