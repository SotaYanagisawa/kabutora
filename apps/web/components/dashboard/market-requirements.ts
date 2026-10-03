import { canonicalDomainSecurityId, domainSecurityIdVariants } from "@kabutora/domain";
import { FX_SECURITY_ID } from "./constants";
import type { RemoteQuote, SearchSecurity, Seed } from "./types";

type Transaction = Seed["transactions"][number];

const sortedIdList = (ids: Iterable<string>) => [...new Set(ids)].sort().join(",");
const yearsBefore = (years: number) => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
};

/** Comma-joined, sorted IDs that need live quotes: holdings, watchlist, open detail page and USD/JPY. */
export function quoteSecurityIdList(holdingIds: string[], watchlist: SearchSecurity[], detailSecurityId: string) {
  return sortedIdList([...holdingIds, ...watchlist.map((item) => item.id), ...(detailSecurityId ? [detailSecurityId] : []), FX_SECURITY_ID]);
}

/** Comma-joined, sorted IDs that need daily history. */
export function historySecurityIdList(transactions: Transaction[], watchlist: SearchSecurity[], needsFxHistory: boolean, detailSecurityId: string) {
  return sortedIdList([
    ...transactions.map((transaction) => transaction.securityId).filter((value): value is string => Boolean(value)),
    ...watchlist.map((item) => item.id),
    ...(needsFxHistory ? [FX_SECURITY_ID] : []),
    ...(detailSecurityId ? [detailSecurityId] : []),
  ]);
}

/** Comma-joined canonical IDs of traded securities (excluding FX) that can pay distributions. */
export function distributionSecurityIdList(transactions: Transaction[]) {
  return sortedIdList(transactions.flatMap((transaction) => {
    if (!transaction.securityId) return [];
    const securityId = canonicalDomainSecurityId(transaction.securityId);
    return securityId.startsWith("sec-fx-") ? [] : [securityId];
  }));
}

/**
 * Earliest history date required per security: first trade for holdings, one year for
 * watchlist-only items, five years for an opened detail page, and FX back to the earliest need.
 */
export function historyCoverageRequirements(transactions: Transaction[], watchlist: SearchSecurity[], detailSecurityId: string, needsFxHistory: boolean, todayKey: string) {
  const earliest = new Map<string, string>();
  for (const transaction of transactions) {
    if (!transaction.securityId) continue;
    const date = transaction.tradeDate.slice(0, 10);
    const current = earliest.get(transaction.securityId);
    if (!current || date < current) earliest.set(transaction.securityId, date);
  }
  const oneYearAgo = yearsBefore(1);
  for (const item of watchlist) if (!earliest.has(item.id)) earliest.set(item.id, oneYearAgo);
  if (detailSecurityId && !earliest.has(detailSecurityId)) earliest.set(detailSecurityId, yearsBefore(5));
  if (needsFxHistory) earliest.set(FX_SECURITY_ID, [...earliest.values()].sort()[0] ?? todayKey);
  return earliest;
}

/** Signature that changes whenever any history requirement changes. */
export const historyRequirementSignature = (requirements: Map<string, string>, todayKey: string) =>
  `${[...requirements].map(([securityId, date]) => `${securityId}:${date}`).sort().join("|")}|${todayKey}`;

/** Quotes keyed by ID, also reachable through every equivalent security-ID spelling. */
export function quoteRecordWithVariants(quotes: RemoteQuote[]) {
  const record: Record<string, RemoteQuote> = {};
  for (const quote of quotes) {
    record[quote.securityId] = quote;
    for (const variant of domainSecurityIdVariants(quote.securityId)) {
      if (!record[variant]) record[variant] = { ...quote, securityId: variant };
    }
  }
  return record;
}
