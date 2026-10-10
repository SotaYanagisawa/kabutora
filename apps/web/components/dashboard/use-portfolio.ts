"use client";

import { tokyoDate } from "@kabutora/domain/dates";
import { marketKey, type Quote } from "@kabutora/domain/market";
import { derivePortfolioNotifications, mergePortfolioNotifications, type PortfolioNotification } from "@kabutora/domain/notifications";
import {
  buildBook,
  convert,
  dividendReceipts,
  fxRateOn,
  intradayHistory,
  portfolioHistory,
  securityHistory,
  tradeRows,
  valuePortfolio,
  withQuotes,
  type Currency,
  type HistoryPoint,
  type LedgerSecurity,
  type Target,
  type Trade,
} from "@kabutora/domain/portfolio";
import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { portfolioMarketSessions } from "@/lib/market/market-session";
import { securityMatchesPortfolioFilter, type PortfolioFilter } from "@/lib/portfolio/portfolio-filter";
import { companyDisplayName, companyLegalName } from "@/lib/ui/company-name";
import { costBasisGroupForAccount, filterDatedHistory, lastTradingDay } from "./helpers";
import type { CustomDateRange, DashboardHolding, DashboardSecurity, DisplayCurrency, DisplayQuote, Freshness, MarketDiagnostics, MarketSecurity, RangeKey, SearchSecurity, Seed, View } from "./types";
import type { MarketDataState } from "./use-market-data";

type Transaction = Seed["transactions"][number];
type Account = Seed["accounts"][number];

const DAY_SECONDS = 86_400;
const NO_QUOTES: ReadonlyMap<string, Quote> = new Map();

function freshnessOf(quote: Quote, nowSeconds: number): Freshness {
  const age = Math.max(0, nowSeconds - quote.time);
  if (quote.venue === "FUND") return age <= 4 * DAY_SECONDS ? "delayed" : "stale";
  if (quote.session !== "closed") return age <= 120 ? "live" : age <= 900 ? "near_live" : "delayed";
  return age <= 3 * DAY_SECONDS ? "near_live" : age <= 7 * DAY_SECONDS ? "cached" : "stale";
}

/** Quote for display, optionally converted into another currency with live/previous USD/JPY. */
export function displayQuote(quote: Quote, security: { exchangeMic?: string } | undefined, nowSeconds: number, convertTo?: { currency: string; now: number | null; previous: number | null }): DisplayQuote | undefined {
  const target = convertTo?.currency ?? quote.currency;
  const price = convert(quote.price, quote.currency, target, convertTo?.now ?? null);
  if (price == null) return undefined;
  const previous = quote.previousClose == null ? null : convert(quote.previousClose, quote.currency, target, convertTo?.previous ?? convertTo?.now ?? null);
  const age = nowSeconds - quote.time;
  return {
    securityId: quote.key,
    currency: target,
    ...(security?.exchangeMic ? { exchangeMic: security.exchangeMic } : {}),
    ...(quote.exchange ? { exchangeLabel: quote.exchange } : {}),
    ...(quote.name ? { shortName: quote.name } : {}),
    ...(quote.longName ? { longName: quote.longName } : {}),
    price,
    previousRegularClose: previous,
    ...(quote.regularPrice != null && quote.regularTime != null
      ? {
        regularPrice: convert(quote.regularPrice, quote.currency, target, convertTo?.now ?? null) ?? undefined,
        regularTimestamp: new Date(quote.regularTime * 1000).toISOString(),
        extendedChangeRatio: quote.price / quote.regularPrice - 1,
      }
      : {}),
    ...(quote.dayHigh != null ? { dayHigh: convert(quote.dayHigh, quote.currency, target, convertTo?.now ?? null) ?? undefined } : {}),
    ...(quote.dayLow != null ? { dayLow: convert(quote.dayLow, quote.currency, target, convertTo?.now ?? null) ?? undefined } : {}),
    ...(quote.volume != null ? { dayVolume: quote.volume } : {}),
    marketTimestamp: new Date(quote.time * 1000).toISOString(),
    fetchedAt: new Date(quote.fetchedAt * 1000).toISOString(),
    freshness: freshnessOf(quote, nowSeconds),
    session: quote.session,
    priceType: quote.session === "closed" || quote.venue === "FUND" ? "official_close" : age <= 900 ? "last_trade" : "delayed_last",
    venueCode: quote.venue,
  };
}

/** Field-wise equality of plain view-model objects, descending `depth` levels into nested objects. */
function sameValue(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth <= 0 || !left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(b);
  return Object.keys(a).length === keys.length && keys.every((key) => sameValue(a[key], b[key], depth - 1));
}

/** Field-wise equality for a security entry; the quote is compared one level deep. */
const sameSecurity = (left: MarketSecurity, right: MarketSecurity) => sameValue(left, right, 2);

type Options = {
  seed: Seed;
  transactions: Transaction[];
  accountMap: ReadonlyMap<string, Account>;
  allSecurities: SearchSecurity[];
  watchlist: SearchSecurity[];
  market: MarketDataState;
  now: number;
  displayCurrency: DisplayCurrency;
  brokerFilter: string;
  marketFilter: PortfolioFilter;
  dividendDisplayCurrency: DisplayCurrency;
  dividendMarketFilter: PortfolioFilter;
  range: RangeKey;
  customRange: CustomDateRange | null;
  priceAlertThreshold: number;
  notificationHistory: PortfolioNotification[];
  setNotificationHistory: Dispatch<SetStateAction<PortfolioNotification[]>>;
  readNotificationIds: string[];
  view: View;
  detailSecurityId: string;
};

/** Everything the dashboard shows, computed by the engine from the ledger and market data. */
export function usePortfolio(o: Options) {
  const { transactions, accountMap, allSecurities, watchlist, market, displayCurrency, brokerFilter, marketFilter } = o;
  const nowSeconds = Math.floor(o.now / 1000);
  const today = tokyoDate(o.now);
  const { fx } = market;
  const quotes = market.data.quotes;

  // ---- Securities ------------------------------------------------------------------------------
  // Entries keep their identity while their content is unchanged, so the clock tick and quote polls
  // do not re-render every memoized row that looks a security up.
  const previousSecurityMap = useRef<Map<string, MarketSecurity>>(new Map());
  const rawSecurityMap = useMemo(() => {
    const previous = previousSecurityMap.current;
    const map = new Map<string, MarketSecurity>();
    let changed = previous.size !== allSecurities.length;
    for (const security of allSecurities) {
      const quote = quotes.get(marketKey(security.id));
      const nameSource = { ...security, shortName: quote?.name ?? security.shortName, longName: quote?.longName ?? security.longName };
      const next: MarketSecurity = {
        ...security,
        name: companyDisplayName(nameSource),
        legalName: companyLegalName(nameSource),
        nativeCurrency: security.currency,
        ...(quote ? { quote: displayQuote(quote, security, nowSeconds) } : {}),
      };
      const before = previous.get(security.id);
      const entry = before && sameSecurity(before, next) ? before : next;
      if (entry !== before) changed = true;
      map.set(security.id, entry);
    }
    return changed ? (previousSecurityMap.current = map) : previous;
  }, [allSecurities, nowSeconds, quotes]);
  // Filters read only static security fields (country, asset type, exchange), never quotes.
  const filterSecurityMap = useMemo(() => new Map(allSecurities.map((security) => [security.id, security])), [allSecurities]);
  const nativeMarketSecurities = useMemo(() => [...rawSecurityMap.values()], [rawSecurityMap]);
  const ledgerSecurities = useMemo(() => new Map<string, LedgerSecurity>(allSecurities.map((security) => [security.id, { id: security.id, currency: security.currency, priceUnit: security.priceUnit }])), [allSecurities]);
  const brokerOptions = useMemo(() => [...new Set([...accountMap.values()].filter((account) => !account.archivedAt).map((account) => account.broker).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [accountMap]);

  // ---- Book: every trade in today's share units ------------------------------------------------
  // Built from the ledger and daily history only. A price poll re-prices it with `withQuotes`, so the
  // engine's cached receipts and past history days are reused and only today's numbers are computed.
  const historyMarket = useMemo(() => ({ quotes: NO_QUOTES, history: market.data.history }), [market.data.history]);
  const ledgerBook = useMemo(
    () => buildBook(transactions, ledgerSecurities, historyMarket, (transaction) => costBasisGroupForAccount(accountMap.get(transaction.accountId), transaction.accountId)),
    [accountMap, historyMarket, ledgerSecurities, transactions],
  );
  const book = useMemo(() => withQuotes(ledgerBook, market.data), [ledgerBook, market.data]);
  const rows = useMemo(() => tradeRows(ledgerBook), [ledgerBook]);
  const include = useMemo(() => (trade: Trade<Transaction>) => {
    if (brokerFilter !== "ALL" && accountMap.get(trade.accountId)?.broker !== brokerFilter && trade.transaction.original?.broker !== brokerFilter) return false;
    return marketFilter === "ALL" || securityMatchesPortfolioFilter(filterSecurityMap.get(trade.securityId) ?? null, marketFilter, trade.securityId);
  }, [accountMap, brokerFilter, filterSecurityMap, marketFilter]);

  // ---- Valuation -----------------------------------------------------------------------------------
  const native = useMemo(() => valuePortfolio(book, { target: "NATIVE", fx, today, include }), [book, fx, include, today]);
  const summaryCurrency: Currency = useMemo(() => {
    if (displayCurrency === "JPY" || displayCurrency === "USD") return displayCurrency;
    const currencies = new Set(native.holdings.map((holding) => holding.currency));
    const sole = currencies.size === 1 ? [...currencies][0] : null;
    if (sole === "USD" || sole === "JPY") return sole;
    if (marketFilter === "US") return "USD";
    return o.seed.portfolio.baseCurrency === "USD" && marketFilter === "ALL" ? "USD" : "JPY";
  }, [displayCurrency, marketFilter, native.holdings, o.seed.portfolio.baseCurrency]);
  const valuation = useMemo(() => valuePortfolio(book, { target: summaryCurrency, fx, today, include }), [book, fx, include, summaryCurrency, today]);
  const summary = valuation.summary;

  // Rows whose numbers did not change keep their object, so a poll re-renders only the cards that moved.
  const previousHoldings = useRef<Map<string, DashboardHolding>>(new Map());
  const holdings = useMemo<DashboardHolding[]>(() => {
    const base = displayCurrency === "NATIVE" ? native.holdings : valuation.holdings;
    const summaryValues = new Map(valuation.holdings.map((holding) => [holding.securityId, holding.marketValue]));
    const previous = previousHoldings.current;
    const next = base.map((holding) => {
      const security = rawSecurityMap.get(holding.securityId) ?? { id: holding.securityId, displaySymbol: holding.securityId, name: holding.securityId, exchangeMic: "", currency: holding.currency };
      const quote = holding.quote ? displayQuote(holding.quote, security, nowSeconds, { currency: holding.currency, now: fx.now, previous: fx.previous }) : undefined;
      const entry: DashboardHolding = { ...holding, security: { ...security, ...(quote ? { quote } : {}) }, summaryMarketValue: summaryValues.get(holding.securityId) ?? null };
      const before = previous.get(holding.securityId);
      return before && sameValue(before, entry, 3) ? before : entry;
    });
    previousHoldings.current = new Map(next.map((holding) => [holding.securityId, holding]));
    return next;
  }, [displayCurrency, fx.now, fx.previous, native.holdings, nowSeconds, rawSecurityMap, valuation.holdings]);

  // ---- Charts ----------------------------------------------------------------------------------------
  const daily = useMemo(() => portfolioHistory(book, { target: summaryCurrency, fx, today, include }), [book, fx, include, summaryCurrency, today]);
  const intradayRange = o.range === "1D" || o.range === "1W";
  // The whole week, so 1D can still show the last trading day on a weekend.
  const intraday = useMemo(() => (intradayRange
    ? intradayHistory(book, { target: summaryCurrency, fx, today, include, since: nowSeconds - 7 * DAY_SECONDS, now: nowSeconds })
    : []), [book, fx, include, intradayRange, nowSeconds, summaryCurrency, today]);
  const history: HistoryPoint[] = useMemo(() => {
    if (o.range === "1D") return lastTradingDay(intraday);
    if (o.range === "1W" && intraday.length > 5) return intraday;
    return filterDatedHistory(daily, o.range, o.customRange);
  }, [daily, intraday, o.customRange, o.range]);
  const portfolioDateBounds = useMemo(() => ({ min: daily[0]?.date ?? today, max: daily.at(-1)?.date ?? today }), [daily, today]);

  // ---- Dividends --------------------------------------------------------------------------------------
  const effectiveDividendCurrency: Currency = useMemo(() => {
    if (o.dividendDisplayCurrency === "JPY" || o.dividendDisplayCurrency === "USD") return o.dividendDisplayCurrency;
    const currencies = new Set(dividendReceipts(book, { target: "NATIVE", fx, today }).filter((receipt) => o.dividendMarketFilter === "ALL"
      || securityMatchesPortfolioFilter(filterSecurityMap.get(receipt.securityId) ?? null, o.dividendMarketFilter, receipt.securityId)).map((receipt) => receipt.currency));
    const sole = currencies.size === 1 ? [...currencies][0] : null;
    if (sole === "USD" || sole === "JPY") return sole;
    if (currencies.size > 1) return "JPY";
    return o.dividendMarketFilter === "US" ? "USD" : o.seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY";
  }, [book, filterSecurityMap, fx, o.dividendDisplayCurrency, o.dividendMarketFilter, o.seed.portfolio.baseCurrency, today]);
  const receipts = useMemo(() => dividendReceipts(book, { target: effectiveDividendCurrency, fx, today }), [book, effectiveDividendCurrency, fx, today]);
  const dividendFxUnavailable = receipts.some((receipt) => receipt.amount == null);

  // ---- Notifications ----------------------------------------------------------------------------------
  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);
  const derivedNotifications = useMemo(() => derivePortfolioNotifications({
    book,
    securities: rawSecurityMap,
    watchedIds,
    threshold: o.priceAlertThreshold / 100,
  }), [book, o.priceAlertThreshold, rawSecurityMap, watchedIds]);
  const { setNotificationHistory } = o;
  useEffect(() => {
    if (!derivedNotifications.length) return;
    setNotificationHistory((current) => {
      const merged = mergePortfolioNotifications(current, derivedNotifications);
      return merged.length === current.length && merged.every((notice, index) => notice.id === current[index]?.id && notice.summary === current[index]?.summary) ? current : merged;
    });
  }, [derivedNotifications, setNotificationHistory]);
  const notifications = useMemo(() => {
    const threshold = o.priceAlertThreshold / 100;
    return mergePortfolioNotifications(o.notificationHistory, derivedNotifications).filter((notice) =>
      !((notice.type === "PRICE_UP" || notice.type === "PRICE_DOWN") && notice.changeRatio != null && Math.abs(Number(notice.changeRatio)) < threshold));
  }, [derivedNotifications, o.notificationHistory, o.priceAlertThreshold]);
  const unreadNotificationCount = useMemo(() => {
    const read = new Set(o.readNotificationIds);
    return notifications.filter((notice) => !read.has(notice.id)).length;
  }, [notifications, o.readNotificationIds]);
  const tradedSecurityIds = useMemo(() => new Set(book.bySecurity.keys()), [book]);

  // ---- Security detail page -------------------------------------------------------------------------
  const { detailSecurityId } = o;
  const detailSecurity = detailSecurityId ? rawSecurityMap.get(detailSecurityId) ?? watchlist.find((item) => item.id === detailSecurityId) : undefined;
  const detailCurrency: string = displayCurrency === "NATIVE" ? (detailSecurity?.currency ?? "JPY") : displayCurrency;
  const detailOptions = useMemo(() => ({ target: (displayCurrency === "NATIVE" ? "NATIVE" : displayCurrency) as Target, fx, today }), [displayCurrency, fx, today]);
  const detail = useMemo(() => {
    if (o.view !== "security" || !detailSecurityId || !detailSecurity) return null;
    const security = detailSecurity as DashboardSecurity;
    const points = securityHistory(book, detailSecurityId, detailOptions);
    const trades = book.bySecurity.get(detailSecurityId) ?? [];
    const firstTrade = trades[0]?.date;
    const quote = quotes.get(marketKey(detailSecurityId));
    const converted = quote ? displayQuote(quote, security, nowSeconds, { currency: detailCurrency, now: fx.now, previous: fx.previous }) : undefined;
    const held = valuePortfolio(book, { ...detailOptions, include: (trade) => trade.securityId === detailSecurityId });
    const holding = held.holdings[0];
    const closed = held.closed[0];
    const selected: DashboardHolding = holding
      ? { ...holding, security: { ...security, ...(converted ? { quote: converted } : {}) } }
      : {
        securityId: detailSecurityId, key: marketKey(detailSecurityId), currency: detailCurrency, quantity: 0, costBasis: 0, averageCost: 0,
        price: converted?.price ?? null, previousClose: converted?.previousRegularClose ?? null, marketValue: null, unrealizedGain: null,
        realizedGain: closed?.realizedGain ?? 0, dividendIncome: closed?.dividendIncome ?? 0,
        dayGain: null, dayChangeRatio: quote?.previousClose ? quote.price / quote.previousClose - 1 : null, splitAdjusted: false,
        ...(quote?.regularPrice != null ? {
          extendedChangeRatio: quote.price / quote.regularPrice - 1,
          ...(quote.previousClose ? { regularChangeRatio: quote.regularPrice / quote.previousClose - 1 } : {}),
        } : {}),
        security: { ...security, ...(converted ? { quote: converted } : {}) },
      };
    return {
      holding: selected,
      positionHistory: firstTrade ? points.filter((point) => point.date >= firstTrade) : [],
      priceHistory: points.map((point) => ({ date: point.date, price: point.price })),
      trades: trades.map((trade) => ({
        side: trade.side,
        quantity: trade.quantity,
        amount: convert(trade.amount, trade.currency, detailCurrency, fxRateOn(fx, trade.date)),
      })),
      currency: detailCurrency,
    };
  }, [book, detailCurrency, detailOptions, detailSecurity, detailSecurityId, fx, nowSeconds, o.view, quotes]);
  const detailTransactions = useMemo(() => transactions.filter((transaction) => transaction.securityId === detailSecurityId), [detailSecurityId, transactions]);

  // ---- Status --------------------------------------------------------------------------------------------
  const marketSessions = useMemo(() => portfolioMarketSessions("ALL", new Date(Math.floor(o.now / 60_000) * 60_000)), [o.now]);
  const diagnostics: MarketDiagnostics = {
    quoteStatus: market.quoteStatus,
    historyStatus: market.historyStatus,
    pricedCount: summary.pricedCount,
    unpricedCount: summary.unpricedCount,
    catalogCount: market.catalog.length,
    historyCount: market.data.history.size,
    historyPending: market.historyPending.length,
    splitAdjustedCount: book.trades.filter((trade) => trade.splitFactor !== 1).length,
    ledgerIssues: book.issues.length,
    benchmarkCount: market.benchmarks.length,
    updatedAt: market.updatedAt,
    currentUsdJpy: fx.now,
  };

  return {
    rawSecurityMap, nativeMarketSecurities, brokerOptions, book, tradeRows: rows,
    summary, summaryCurrency, holdings, history, portfolioDateBounds,
    receipts, effectiveDividendCurrency, dividendFxUnavailable,
    notifications, unreadNotificationCount, tradedSecurityIds,
    detail, detailTransactions,
    marketSessions, diagnostics,
    currentUsdJpy: fx.now,
  };
}

export type PortfolioViewModel = ReturnType<typeof usePortfolio>;
