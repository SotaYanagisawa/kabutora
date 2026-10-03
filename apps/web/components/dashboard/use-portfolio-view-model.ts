"use client";

import {
  calculateAverageCostPortfolio,
  calculateDividendIncome,
  canonicalDomainSecurityId,
  Decimal,
  domainSecurityIdVariants,
  matchSecurityId,
  summarizeDividendReceipts,
  type CorporateAction,
  type DistributionEvent,
  type IntradayBar,
  type MarketBar,
  type MarketQuote,
} from "@kabutora/domain";
import { useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { companyDisplayName, companyLegalName } from "@/lib/ui/company-name";
import { historicalFxRateAtDate, historicalFxRateAtTimestamp } from "@/lib/portfolio/historical-fx";
import { isUsSecurity, securityMatchesPortfolioFilter, type PortfolioFilter } from "@/lib/portfolio/portfolio-filter";
import { derivePortfolioNotifications, mergePortfolioNotifications, type PortfolioNotification } from "@/lib/portfolio/portfolio-notifications";
import { projectStockPortfolio } from "@/lib/portfolio/portfolio-consistency";
import { emptyPortfolioCalculation, type HistoryDataset } from "@/lib/portfolio/portfolio-history-calculation";
import { portfolioMarketSessions, selectReliableMarketSessions, type MarketSessionStatus } from "@/lib/market/market-session";
import { sanitizeDatedPoints, trailingHours } from "@/lib/charts/chart-presentation";
import { FX_SECURITY_ID, seededMarketNotices } from "./constants";
import { convertAmount, securityPriceUnit, validUsdJpy } from "./helpers";
import { usePortfolioHistory } from "./use-portfolio-history";
import type { Benchmark, CustomDateRange, DisplayCurrency, RangeKey, RemoteQuote, SearchSecurity, Seed, View } from "./types";

type Transaction = Seed["transactions"][number];
type Account = Seed["accounts"][number];
type CalculationTransaction = Transaction & { costBasisGroup?: string };
type CurrencyCarrier = { currency?: string; nativeCurrency?: string; country?: string; id?: string; displaySymbol?: string } | null | undefined;
const FILTERS = ["ALL", "JP", "US", "FUNDS_INDEXES"] as const;
const DAY_MS = 86_400_000;
const FX_STORAGE_KEY = "kabutora-usdjpy-observation-v1";

/** Native trading currency for a security, falling back to its ID's market. */
export const nativeCurrencyOf = (security: CurrencyCarrier, securityId?: string) =>
  security?.currency ?? security?.nativeCurrency ?? (isUsSecurity(security, securityId) ? "USD" : "JPY");

/** Map from ID to item that also resolves every equivalent security-ID spelling. */
function mapWithIdVariants<T extends { id: string }>(items: T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
    for (const variant of domainSecurityIdVariants(item.id)) if (!map.has(variant)) map.set(variant, { ...item, id: variant });
  }
  return map;
}

/** Groups bars by canonical security (deduplicated by `keyOf`), sorted, reachable through every ID variant. */
function groupBySecurity<T extends { securityId: string }>(bars: T[], keyOf: (bar: T) => string, finish: (canonical: string, bars: T[]) => T[]) {
  const byCanonical = new Map<string, Map<string, T>>();
  for (const bar of bars) {
    if (bar.securityId === FX_SECURITY_ID) continue;
    const canonical = canonicalDomainSecurityId(bar.securityId);
    let byKey = byCanonical.get(canonical);
    if (!byKey) byCanonical.set(canonical, byKey = new Map());
    byKey.set(keyOf(bar), bar);
  }
  const grouped = new Map<string, T[]>();
  for (const [canonical, byKey] of byCanonical) {
    const finished = finish(canonical, [...byKey.values()]);
    for (const id of domainSecurityIdVariants(canonical)) grouped.set(id, finished);
  }
  return grouped;
}

/** IDs plus their canonical forms. */
function idsWithCanonical(transactions: Array<{ securityId?: string | null }>) {
  const ids = new Set<string>();
  for (const transaction of transactions) {
    if (!transaction.securityId) continue;
    ids.add(transaction.securityId);
    ids.add(canonicalDomainSecurityId(transaction.securityId));
  }
  return ids;
}

type Options = {
  seed: Seed;
  storage: Storage;
  transactions: Transaction[];
  calculationTransactions: CalculationTransaction[];
  allSecurities: SearchSecurity[];
  customSecurities: SearchSecurity[];
  watchlist: SearchSecurity[];
  accountMap: Map<string, Account>;
  applicableCorporateActions: CorporateAction[];
  todayKey: string;
  sessionClock: number | null;
  quotes: Record<string, RemoteQuote>;
  benchmarks: Benchmark[];
  historyBars: MarketBar[];
  intradayBars: IntradayBar[];
  distributions: DistributionEvent[];
  serverMarketSessions: MarketSessionStatus[];
  displayCurrency: DisplayCurrency;
  dividendDisplayCurrency: DisplayCurrency;
  dividendMarketFilter: PortfolioFilter;
  brokerFilter: string;
  marketFilter: PortfolioFilter;
  range: RangeKey;
  customRange: CustomDateRange | null;
  priceAlertThreshold: number;
  notificationHistory: PortfolioNotification[];
  setNotificationHistory: Dispatch<SetStateAction<PortfolioNotification[]>>;
  readNotificationIds: string[];
  view: View;
  detailSecurityId: string;
  workspaceRef: MutableRefObject<HTMLElement | null>;
};

/**
 * Everything the dashboard views display, derived from the ledger, market data and preferences:
 * FX rates, display-currency conversion, per-filter summaries (computed in the domain worker),
 * holdings, dividends, notifications and chart series.
 */
export function usePortfolioViewModel(o: Options) {
  const { seed, storage, transactions, calculationTransactions, allSecurities, watchlist, accountMap, applicableCorporateActions, todayKey, sessionClock, quotes, benchmarks, historyBars, intradayBars, displayCurrency, brokerFilter, marketFilter } = o;

  // ---- FX -------------------------------------------------------------------
  const usdJpyBenchmark = benchmarks.find((benchmark) => benchmark.id === "usd-jpy");
  const fxHistory = useMemo(() => historyBars.filter((bar) => bar.securityId === FX_SECURITY_ID).sort((a, b) => a.date.localeCompare(b.date)), [historyBars]);
  const fxIntradayBars = useMemo(() => intradayBars.filter((bar) => bar.securityId === FX_SECURITY_ID).sort((a, b) => a.timestamp.localeCompare(b.timestamp)), [intradayBars]);
  const fxQuote = quotes[FX_SECURITY_ID];
  const quoteUsdJpy = fxQuote?.price != null ? Number(fxQuote.price) : null;
  const historyUsdJpy = fxHistory.at(-1)?.close != null ? Number(fxHistory.at(-1)!.close) : null;
  const storedFx = useMemo(() => {
    try {
      const value = JSON.parse(storage.getItem(FX_STORAGE_KEY) ?? "null") as { rate: number; source: string; asOf: string } | null;
      return value && validUsdJpy(value.rate) && value.source && Number.isFinite(Date.parse(value.asOf)) ? value : null;
    } catch { return null; }
  }, [storage]);
  const currentFx = validUsdJpy(usdJpyBenchmark?.value)
    ? { rate: usdJpyBenchmark.value, source: "market-benchmark", asOf: usdJpyBenchmark.marketTimestamp }
    : validUsdJpy(quoteUsdJpy)
      ? { rate: quoteUsdJpy, source: "market-quote", asOf: fxQuote.marketTimestamp }
      : validUsdJpy(historyUsdJpy)
        ? { rate: historyUsdJpy, source: "daily-history", asOf: fxHistory.at(-1)!.date }
        : storedFx;
  const currentUsdJpy = currentFx?.rate ?? null;
  const validCurrentUsdJpy = validUsdJpy(currentUsdJpy) ? currentUsdJpy : null;
  useEffect(() => {
    if (currentFx) storage.setItem(FX_STORAGE_KEY, JSON.stringify(currentFx));
  }, [currentFx?.rate, currentFx?.asOf, currentFx?.source, storage]); // eslint-disable-line react-hooks/exhaustive-deps
  const quotePreviousUsdJpy = fxQuote?.previousRegularClose != null ? Number(fxQuote.previousRegularClose) : null;
  const benchmarkPreviousUsdJpy = validCurrentUsdJpy != null && usdJpyBenchmark?.changeRatio != null && 1 + usdJpyBenchmark.changeRatio > 0
    ? new Decimal(validCurrentUsdJpy).div(new Decimal(1).plus(usdJpyBenchmark.changeRatio)).toNumber()
    : null;
  const previousUsdJpy = validUsdJpy(quotePreviousUsdJpy) ? quotePreviousUsdJpy : validUsdJpy(benchmarkPreviousUsdJpy) ? benchmarkPreviousUsdJpy : currentUsdJpy;
  const fxAtDate = useMemo(() => (date: string) => historicalFxRateAtDate(fxHistory, date, validCurrentUsdJpy, true, todayKey), [validCurrentUsdJpy, fxHistory, todayKey]);
  const fxAtTimestamp = useMemo(() => (timestamp: string) => historicalFxRateAtTimestamp(fxIntradayBars, fxHistory, timestamp, validCurrentUsdJpy, true, todayKey), [validCurrentUsdJpy, fxHistory, fxIntradayBars, todayKey]);
  const rateOn = (date: string) => fxAtDate(date) ?? validCurrentUsdJpy;

  // ---- Securities (native and display currency) ------------------------------
  const nativeMarketSecurities = useMemo(() => allSecurities.map((security) => {
    const quote = resolveQuote(quotes, security.id);
    const nameSource = { ...security, brandName: quote?.brandName ?? security.brandName, shortName: quote?.shortName ?? security.shortName, longName: quote?.longName ?? security.longName };
    return { ...security, name: companyDisplayName(nameSource), legalName: companyLegalName(nameSource), quote };
  }), [allSecurities, quotes]);
  const rawSecurityMap = useMemo(() => mapWithIdVariants(nativeMarketSecurities), [nativeMarketSecurities]);
  const marketSecurities = useMemo(() => nativeMarketSecurities.map((security) => {
    if (displayCurrency === "NATIVE") return security;
    const nativeCurrency = security.currency;
    const quote = security.quote;
    if (!quote) return { ...security, nativeCurrency, currency: displayCurrency };
    const convert = (value: string | null | undefined, rate: number | null) => convertAmount(value, nativeCurrency, displayCurrency, rate);
    const price = convert(quote.price, currentUsdJpy);
    if (price == null) return { ...security, nativeCurrency, currency: displayCurrency, quote: undefined };
    const previousRegularClose = convert(quote.previousRegularClose, previousUsdJpy);
    const dayOpen = convert(quote.dayOpen, currentUsdJpy);
    const dayHigh = convert(quote.dayHigh, currentUsdJpy);
    const dayLow = convert(quote.dayLow, currentUsdJpy);
    return {
      ...security,
      nativeCurrency,
      currency: displayCurrency,
      quote: {
        ...quote,
        price,
        ...(previousRegularClose != null ? { previousRegularClose } : {}),
        ...(dayOpen != null ? { dayOpen } : {}),
        ...(dayHigh != null ? { dayHigh } : {}),
        ...(dayLow != null ? { dayLow } : {}),
      },
    };
  }), [currentUsdJpy, displayCurrency, nativeMarketSecurities, previousUsdJpy]);
  const securityMap = useMemo(() => mapWithIdVariants(marketSecurities), [marketSecurities]);

  // ---- Filtered summary inputs -----------------------------------------------
  const brokerOptions = useMemo(() => [...new Set([...accountMap.values()].filter((account) => !account.archivedAt).map((account) => account.broker).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [accountMap]);
  const brokerTransactions = useMemo(() => brokerFilter === "ALL" ? calculationTransactions : calculationTransactions.filter((transaction) =>
    accountMap.get(transaction.accountId)?.broker === brokerFilter || transaction.original?.broker === brokerFilter,
  ), [accountMap, brokerFilter, calculationTransactions]);
  /** Per market filter: visible transactions and the currency the summary is shown in. */
  const summaryViewInputs = useMemo(() => {
    const inputs = new Map<PortfolioFilter, { transactions: CalculationTransaction[]; currency: "JPY" | "USD" }>();
    for (const filter of FILTERS) {
      const visible = filter === "ALL" ? brokerTransactions : brokerTransactions.filter((transaction) => {
        const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
        if (security) return securityMatchesPortfolioFilter(security, filter);
        if (filter === "FUNDS_INDEXES") return false;
        return (transaction.tradeCurrency === "USD" ? "US" : "JP") === filter;
      });
      let currency: "JPY" | "USD";
      if (displayCurrency === "USD" || displayCurrency === "JPY") {
        currency = displayCurrency;
      } else {
        // NATIVE: a single held currency is shown as-is; mixed currencies fall back by filter/base currency.
        const netQuantity = new Map<string, Decimal>();
        for (const transaction of visible) {
          if (!transaction.securityId) continue;
          const current = netQuantity.get(transaction.securityId) ?? new Decimal(0);
          const quantity = new Decimal(transaction.quantity || 0);
          netQuantity.set(transaction.securityId, transaction.type === "BUY" ? current.plus(quantity) : current.minus(quantity));
        }
        const currencies = new Set<string>();
        for (const [securityId, quantity] of netQuantity) if (quantity.gt(0)) currencies.add(nativeCurrencyOf(rawSecurityMap.get(securityId), securityId));
        if (!currencies.size) {
          for (const transaction of visible) {
            const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
            const native = transaction.tradeCurrency ?? security?.currency ?? (security as CurrencyCarrier)?.nativeCurrency ?? (isUsSecurity(security, transaction.securityId ?? undefined) ? "USD" : null);
            if (native) currencies.add(native);
          }
        }
        const sole = currencies.size === 1 ? [...currencies][0] : null;
        currency = sole === "USD" || sole === "JPY" ? sole : filter === "US" ? "USD" : seed.portfolio.baseCurrency === "USD" && filter === "ALL" ? "USD" : "JPY";
      }
      inputs.set(filter, { transactions: visible, currency });
    }
    return inputs;
  }, [brokerTransactions, displayCurrency, rawSecurityMap, seed.portfolio.baseCurrency]);
  const { transactions: summaryVisibleTransactions, currency: summaryCurrency } = summaryViewInputs.get(marketFilter)!;

  const allConvertedTransactions = useMemo(() => calculationTransactions.flatMap((transaction) => {
    if (displayCurrency === "NATIVE") return [transaction];
    const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
    const tradeCurrency = transaction.tradeCurrency ?? nativeCurrencyOf(security, transaction.securityId ?? undefined);
    const rate = rateOn(transaction.tradeDate);
    const grossAmount = convertAmount(transaction.grossAmount, tradeCurrency, displayCurrency, rate);
    const pricePerShare = convertAmount(transaction.pricePerShare, tradeCurrency, displayCurrency, rate);
    if (tradeCurrency !== displayCurrency && (!validUsdJpy(rate) || (transaction.grossAmount != null && grossAmount == null))) return [];
    return [{ ...transaction, grossAmount, pricePerShare, tradeCurrency: displayCurrency }];
  }), [calculationTransactions, currentUsdJpy, displayCurrency, fxAtDate, rawSecurityMap]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Notifications ----------------------------------------------------------
  const monitoredSecurityIds = useMemo(() => new Set([
    ...calculationTransactions.map((transaction) => transaction.securityId).filter((id): id is string => Boolean(id)),
    ...watchlist.map((item) => item.id),
  ]), [calculationTransactions, watchlist]);
  const derivedNotifications = useMemo(() => derivePortfolioNotifications({
    transactions: calculationTransactions,
    securities: nativeMarketSecurities,
    actions: applicableCorporateActions,
    bars: historyBars,
    intradayBars,
    externalNotices: seededMarketNotices,
    priceMoveThreshold: o.priceAlertThreshold / 100,
    monitoredSecurityIds,
  }), [applicableCorporateActions, calculationTransactions, historyBars, intradayBars, monitoredSecurityIds, nativeMarketSecurities, o.priceAlertThreshold]);
  const portfolioNotifications = useMemo(() => {
    const threshold = o.priceAlertThreshold / 100;
    return mergePortfolioNotifications(o.notificationHistory, derivedNotifications).filter((notice) =>
      !((notice.type === "PRICE_UP" || notice.type === "PRICE_DOWN") && notice.changeRatio != null && Math.abs(Number(notice.changeRatio)) < threshold));
  }, [derivedNotifications, o.notificationHistory, o.priceAlertThreshold]);
  const { setNotificationHistory } = o;
  useEffect(() => {
    if (!derivedNotifications.length) return;
    setNotificationHistory((current) => {
      const merged = mergePortfolioNotifications(current, derivedNotifications);
      return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
    });
  }, [derivedNotifications, setNotificationHistory]);
  const allTransactionSecurityIds = useMemo(() => idsWithCanonical(transactions), [transactions]);
  const unreadNotificationCount = useMemo(() => {
    const read = new Set(o.readNotificationIds);
    return portfolioNotifications.filter((notice) => !read.has(notice.id)).length;
  }, [portfolioNotifications, o.readNotificationIds]);

  // ---- Dividends ---------------------------------------------------------------
  const allRecognizedDistributions = useMemo(() => o.distributions.filter((event) => {
    const recognitionDate = (event.paymentDate ?? event.exDate ?? event.recordDate ?? "").slice(0, 10);
    return Boolean(recognitionDate) && recognitionDate <= todayKey;
  }), [o.distributions, todayKey]);
  const allNativeDividendSummary = useMemo(() => calculateDividendIncome(calculationTransactions, allRecognizedDistributions, applicableCorporateActions, todayKey), [applicableCorporateActions, allRecognizedDistributions, calculationTransactions, todayKey]);
  const nativeReceipts = allNativeDividendSummary.receipts;
  const effectiveDividendCurrency: "JPY" | "USD" = useMemo(() => {
    if (o.dividendDisplayCurrency === "USD" || o.dividendDisplayCurrency === "JPY") return o.dividendDisplayCurrency;
    const filter = o.dividendMarketFilter;
    const currencies = new Set<string>();
    for (const receipt of nativeReceipts) {
      const security = receipt.securityId ? rawSecurityMap.get(receipt.securityId) : null;
      const visible = filter === "ALL" || (security ? securityMatchesPortfolioFilter(security, filter) : filter !== "FUNDS_INDEXES" && (receipt.currency === "USD" ? "US" : "JP") === filter);
      if (visible) currencies.add(receipt.currency ?? receipt.sourceCurrency ?? nativeCurrencyOf(security, receipt.securityId));
    }
    if (!currencies.size) {
      for (const transaction of summaryVisibleTransactions) {
        const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
        const native = transaction.tradeCurrency ?? security?.currency ?? (security as CurrencyCarrier)?.nativeCurrency ?? (isUsSecurity(security, transaction.securityId ?? undefined) ? "USD" : null);
        if (native) currencies.add(native);
      }
    }
    if (currencies.size > 1) return "JPY";
    const single = [...currencies][0];
    if (single === "USD" || single === "JPY") return single;
    if (filter === "US") return "USD";
    return seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY";
  }, [nativeReceipts, o.dividendDisplayCurrency, o.dividendMarketFilter, rawSecurityMap, seed.portfolio.baseCurrency, summaryVisibleTransactions]);

  /** Receipts converted to `currency`; unconvertible receipts are kept native or dropped. */
  const convertReceipts = (currency: "JPY" | "USD", keepUnconverted: boolean) => nativeReceipts.flatMap((receipt) => {
    const grossAmount = convertAmount(receipt.grossAmount, receipt.currency, currency, rateOn(receipt.recognitionDate));
    if (grossAmount == null) return keepUnconverted ? [receipt] : [];
    return [{ ...receipt, sourceCurrency: receipt.sourceCurrency ?? receipt.currency, sourceGrossAmount: receipt.sourceGrossAmount ?? receipt.grossAmount, grossAmount: grossAmount.toString(), currency }];
  });
  const allConvertedDividendReceipts = useMemo(() => convertReceipts(effectiveDividendCurrency, true), [nativeReceipts, currentUsdJpy, effectiveDividendCurrency, fxAtDate]); // eslint-disable-line react-hooks/exhaustive-deps
  const dividendFxUnavailable = allConvertedDividendReceipts.some((receipt) => receipt.currency !== effectiveDividendCurrency);
  const summaryVisibleSecurityIds = useMemo(() => idsWithCanonical(summaryVisibleTransactions), [summaryVisibleTransactions]);
  const inSummary = (receipt: { accountId: string; securityId: string }) =>
    (brokerFilter === "ALL" || accountMap.get(receipt.accountId)?.broker === brokerFilter)
    && (summaryVisibleSecurityIds.has(receipt.securityId) || summaryVisibleSecurityIds.has(canonicalDomainSecurityId(receipt.securityId)));
  const allSummaryConvertedDividendReceipts = useMemo(() => convertReceipts(summaryCurrency, false), [nativeReceipts, currentUsdJpy, summaryCurrency, fxAtDate]); // eslint-disable-line react-hooks/exhaustive-deps
  const summaryDividendSummary = useMemo(() => summarizeDividendReceipts(allSummaryConvertedDividendReceipts.filter(inSummary)), [accountMap, allSummaryConvertedDividendReceipts, brokerFilter, summaryVisibleSecurityIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const summaryNativeDividendReceipts = useMemo(() => nativeReceipts.filter(inSummary), [accountMap, nativeReceipts, brokerFilter, summaryVisibleSecurityIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const emptyReceiptsRef = useRef<typeof nativeReceipts>([]);
  const stableDividendReceipts = nativeReceipts.length ? nativeReceipts : emptyReceiptsRef.current;

  // ---- Worker calculation ----------------------------------------------------------
  const historyDataset = useMemo<HistoryDataset>(() => ({
    transactions: calculationTransactions,
    securities: nativeMarketSecurities,
    bars: historyBars,
    corporateActions: applicableCorporateActions,
    distributions: [],
    dividendReceipts: stableDividendReceipts,
    fx: { current: currentUsdJpy, previous: previousUsdJpy },
  }), [calculationTransactions, nativeMarketSecurities, historyBars, applicableCorporateActions, stableDividendReceipts, currentUsdJpy, previousUsdJpy]);
  const historyCalculation = usePortfolioHistory({ dataset: historyDataset, summaryViewInputs, activeFilter: marketFilter, brokerFilter, todayKey, workspaceRef: o.workspaceRef });
  const { activeResult, completed } = historyCalculation;

  // Summary calculation is Decimal-heavy. It already runs in the domain
  // worker together with history reconstruction, so doing it twice again on
  // the main thread made every filter interaction block a frame. Retain the
  // last complete result until the worker atomically supplies the new view.
  const calculation = activeResult ?? completed?.result ?? emptyPortfolioCalculation;
  const reconstructedHistory = useMemo(() => activeResult?.points ?? completed?.result?.points ?? [], [activeResult, completed]);
  const precalculatedSummary = completed?.result?.filterSummaries?.[marketFilter];
  const visibleSummary = activeResult?.summary ?? (marketFilter === "ALL" ? calculation.summary : (precalculatedSummary ?? calculation.summary));
  const nativeSummary = activeResult?.nativeSummary ?? calculation.nativeSummary;
  const activeSummary = useMemo(() => projectStockPortfolio(visibleSummary), [visibleSummary]);
  const reconciliation = calculation.reconciliation;

  // ---- Valuation readiness and headline metrics -------------------------------------
  const conversionDates = [
    ...summaryVisibleTransactions.filter((transaction) => transaction.tradeCurrency !== summaryCurrency).map((transaction) => transaction.tradeDate.slice(0, 10)),
    ...summaryNativeDividendReceipts.filter((receipt) => receipt.currency !== summaryCurrency).map((receipt) => receipt.recognitionDate.slice(0, 10)),
  ].filter(Boolean).sort();
  const fxConversionReady = !conversionDates.length || validCurrentUsdJpy != null;
  const fxEstimated = conversionDates.some((date) => !fxHistory.length || date < fxHistory[0]!.date || (date > fxHistory.at(-1)!.date && date < todayKey))
    || Boolean(currentFx && Date.now() - Date.parse(currentFx.asOf) > 72 * 60 * 60 * 1000);
  const securityScope = summaryVisibleTransactions.some((transaction) => transaction.securityId);
  const valuationComplete = fxConversionReady && reconciliation.valid && (activeSummary?.unpricedSecurityCount ?? 0) === 0 && ((activeSummary?.pricedSecurityCount ?? 0) > 0 || !securityScope);
  const totalValue = valuationComplete && activeSummary?.totalValue != null ? Number(activeSummary.totalValue) : null;
  const dayGain = valuationComplete && activeSummary?.dayGain != null ? Number(activeSummary.dayGain) : null;
  const previousValue = totalValue != null && dayGain != null && activeSummary?.totalValue != null && activeSummary?.dayGain != null ? new Decimal(activeSummary.totalValue).minus(activeSummary.dayGain) : null;
  const dayReturn = previousValue && !previousValue.isZero() && activeSummary?.dayGain != null ? new Decimal(activeSummary.dayGain).div(previousValue).toNumber() : null;
  const totalGain = activeSummary?.totalGain != null ? Number(activeSummary.totalGain) : null;
  const totalReturn = valuationComplete && activeSummary?.costBasis && !new Decimal(activeSummary.costBasis).isZero() && activeSummary?.totalGain != null
    ? new Decimal(activeSummary.totalGain).div(activeSummary.costBasis).toNumber()
    : null;

  // ---- Holdings ---------------------------------------------------------------------
  const holdings = useMemo(() => {
    const fallbackSecurity = (securityId: string) => {
      const isUs = isUsSecurity(null, securityId);
      const isFund = securityId.startsWith("sec-fund-") || securityId.includes("-fund-");
      const displaySymbol = securityId.replace(/^sec-(?:us-|jp-)?/i, "").replace(/-(?:xtks|tse|xnas|xnys|arcx|xase|bats|otcm)$/i, "").toUpperCase();
      return {
        id: securityId, displaySymbol, name: displaySymbol, legalName: displaySymbol,
        assetType: (isFund ? "fund" : "stock") as "fund" | "stock" | "index",
        country: isUs ? "US" : "JP", exchangeMic: isUs ? "XNAS" : "XTKS", currency: isUs ? "USD" : "JPY", exchangeLabel: isUs ? "NASDAQ" : "東証",
        priceUnit: "1", quote: undefined as RemoteQuote | undefined,
      };
    };
    const resolveSecurity = (securityId: string) => {
      const canonical = canonicalDomainSecurityId(securityId);
      const existing = securityMap.get(securityId) ?? securityMap.get(canonical) ?? rawSecurityMap.get(securityId) ?? rawSecurityMap.get(canonical)
        ?? seed.securities.find((security) => security.id === securityId || security.id === canonical);
      const fallback = fallbackSecurity(securityId);
      if (!existing) return fallback;
      return {
        ...existing,
        displaySymbol: existing.displaySymbol || fallback.displaySymbol,
        name: existing.name || existing.displaySymbol || fallback.name,
        legalName: (existing as { legalName?: string }).legalName || existing.name || existing.displaySymbol || fallback.legalName,
        exchangeMic: existing.exchangeMic || fallback.exchangeMic,
        country: existing.country || fallback.country,
        currency: (existing as { currency?: string }).currency || fallback.currency,
      };
    };
    if (displayCurrency === "NATIVE") {
      const base = (nativeSummary?.holdings ?? []).filter((holding) => marketFilter === "ALL" || securityMatchesPortfolioFilter(resolveSecurity(holding.securityId), marketFilter, holding.securityId));
      return base.map((holding) => ({
        ...holding,
        security: resolveSecurity(holding.securityId),
        summaryMarketValue: visibleSummary?.holdings?.find((item) => item.securityId === holding.securityId)?.marketValue ?? null,
      }));
    }
    return (visibleSummary?.holdings ?? []).map((holding) => ({ ...holding, security: resolveSecurity(holding.securityId), summaryMarketValue: holding.marketValue }));
  }, [displayCurrency, marketFilter, nativeSummary?.holdings, rawSecurityMap, securityMap, seed.securities, visibleSummary?.holdings]);

  // ---- Chart series --------------------------------------------------------------------
  /** Intraday bars in the display currency (native per security when NATIVE). */
  const intradayBySecurity = useMemo(() => groupBySecurity(intradayBars.flatMap((bar) => {
    if (bar.securityId === FX_SECURITY_ID) return [];
    const security = rawSecurityMap.get(bar.securityId) ?? rawSecurityMap.get(canonicalDomainSecurityId(bar.securityId));
    const nativeCurrency = nativeCurrencyOf(security, bar.securityId);
    const price = convertAmount(bar.price, nativeCurrency, displayCurrency === "NATIVE" ? nativeCurrency : displayCurrency, fxAtTimestamp(bar.timestamp) ?? validCurrentUsdJpy ?? undefined);
    return price == null ? [] : [{ ...bar, price: price.toString() }];
  }), (bar) => bar.timestamp, (_, bars) => bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp))), [validCurrentUsdJpy, displayCurrency, fxAtTimestamp, intradayBars, rawSecurityMap]);
  /** Daily bars of the open detail page's security, in the summary currency. */
  const convertedHistoryBars = useMemo(() => o.view !== "security" ? [] : historyBars.flatMap((bar) => {
    if (bar.securityId === FX_SECURITY_ID || canonicalDomainSecurityId(bar.securityId) !== canonicalDomainSecurityId(o.detailSecurityId)) return [];
    const nativeCurrency = nativeCurrencyOf(rawSecurityMap.get(bar.securityId), bar.securityId);
    const rate = fxAtDate(bar.date);
    const close = convertAmount(bar.close, nativeCurrency, summaryCurrency, rate);
    const adjustedClose = convertAmount(bar.adjustedClose, nativeCurrency, summaryCurrency, rate);
    return close == null ? [] : [{ ...bar, close, ...(adjustedClose != null ? { adjustedClose } : {}) }];
  }), [o.detailSecurityId, summaryCurrency, fxAtDate, historyBars, rawSecurityMap, o.view]);

  /** Portfolio value through the current session, replaying each holding's intraday price changes. */
  const intradayHistory = useMemo(() => {
    const changesByTimestamp = new Map<string, Array<{ securityId: string; price: string }>>();
    const holdingValues = new Map<string, Decimal>();
    let portfolioValue = new Decimal(0);
    for (const holding of holdings) {
      const quote = (holding.security as { quote?: MarketQuote | RemoteQuote } | undefined)?.quote;
      const securityBars = intradayBySecurity.get(holding.securityId) ?? [];
      const startingPrice = String(securityBars.length ? securityBars[0].price : holding.currentPrice ?? quote?.previousRegularClose ?? "0");
      const openingValue = new Decimal(holding.quantity).mul(startingPrice).div(securityPriceUnit(holding.security));
      holdingValues.set(holding.securityId, openingValue);
      portfolioValue = portfolioValue.plus(openingValue);
      for (const bar of securityBars) {
        const changes = changesByTimestamp.get(bar.timestamp) ?? [];
        changes.push({ securityId: holding.securityId, price: String(bar.price) });
        changesByTimestamp.set(bar.timestamp, changes);
      }
    }
    const timestamps = [...changesByTimestamp.keys()].sort((a, b) => a.localeCompare(b));
    if (!timestamps.length) return [];
    const holdingBySecurity = new Map(holdings.map((holding) => [holding.securityId, holding]));
    const openingTime = new Date(timestamps[0]);
    openingTime.setMinutes(openingTime.getMinutes() - 15);
    const dividends = new Decimal(summaryDividendSummary.totalIncome);
    const points = [{ date: openingTime.toISOString(), value: portfolioValue.toNumber(), dividendAdjustedValue: portfolioValue.plus(dividends).toNumber(), capital: Number(activeSummary.costBasis) }];
    for (const timestamp of timestamps) {
      for (const change of changesByTimestamp.get(timestamp) ?? []) {
        const holding = holdingBySecurity.get(change.securityId);
        if (!holding) continue;
        const nextValue = new Decimal(holding.quantity).mul(change.price).div(securityPriceUnit(holding.security));
        portfolioValue = portfolioValue.minus(holdingValues.get(change.securityId) ?? 0).plus(nextValue);
        holdingValues.set(change.securityId, nextValue);
      }
      points.push({ date: timestamp, value: portfolioValue.toNumber(), dividendAdjustedValue: portfolioValue.plus(dividends).toNumber(), capital: Number(activeSummary.netDeposits) });
    }
    return sanitizeDatedPoints(points, "value");
  }, [activeSummary.costBasis, activeSummary.netDeposits, summaryDividendSummary.totalIncome, holdings, intradayBySecurity]);

  const portfolioHistoryByRange = useMemo(() => {
    const all = reconstructedHistory.map((point) => ({ date: point.date, value: Number(point.totalValue), dividendAdjustedValue: Number(point.dividendAdjustedValue), capital: Number(point.investedCapital) }));
    const latestDate = all.at(-1)?.date.slice(0, 10) ?? todayKey;
    const since = (rangeKey: "1W" | "1M" | "3M" | "YTD") => {
      const cutoff = new Date(`${latestDate}T00:00:00Z`);
      if (rangeKey === "1W") cutoff.setUTCDate(cutoff.getUTCDate() - 7);
      if (rangeKey === "1M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
      if (rangeKey === "3M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
      if (rangeKey === "YTD") cutoff.setUTCMonth(0, 1);
      const cutoffKey = cutoff.toISOString().slice(0, 10);
      return all.filter((point) => point.date.slice(0, 10) >= cutoffKey);
    };
    return new Map<RangeKey, typeof all>([["ALL", all], ["1W", since("1W")], ["1M", since("1M")], ["3M", since("3M")], ["YTD", since("YTD")]]);
  }, [reconstructedHistory, todayKey]);
  const { range, customRange } = o;
  const history = useMemo(() => {
    if (range === "1D") return trailingHours(intradayHistory, 24);
    if (range === "1W" && intradayHistory.length > 5) {
      const cutoff = new Date(intradayHistory.at(-1)!.date).getTime() - 7 * DAY_MS;
      return intradayHistory.filter((point) => new Date(point.date).getTime() >= cutoff);
    }
    const all = portfolioHistoryByRange.get("ALL") ?? [];
    if (range === "CUSTOM" && customRange) return all.filter((point) => {
      const date = point.date.slice(0, 10);
      return date >= customRange.from && date <= customRange.to;
    });
    return portfolioHistoryByRange.get(range) ?? all;
  }, [customRange, intradayHistory, portfolioHistoryByRange, range]);
  const portfolioDateBounds = useMemo(() => ({
    min: reconstructedHistory[0]?.date.slice(0, 10) ?? summaryVisibleTransactions.map((transaction) => transaction.tradeDate.slice(0, 10)).sort()[0] ?? todayKey,
    max: reconstructedHistory.at(-1)?.date.slice(0, 10) ?? todayKey,
  }), [reconstructedHistory, todayKey, summaryVisibleTransactions]);

  const latestQuoteAt = Object.values(quotes).map((quote) => quote.fetchedAt).sort().at(-1) ?? null;
  const marketSessions = useMemo(() => selectReliableMarketSessions("ALL", sessionClock == null ? [] : portfolioMarketSessions("ALL", new Date(sessionClock)), o.serverMarketSessions), [o.serverMarketSessions, sessionClock]);

  // ---- Security detail page ------------------------------------------------------------
  const { detailSecurityId } = o;
  const detailTransactions = useMemo(() => (displayCurrency === "NATIVE" ? calculationTransactions : allConvertedTransactions).filter((transaction) => transaction.securityId === detailSecurityId),
    [allConvertedTransactions, calculationTransactions, detailSecurityId, displayCurrency]);
  const selectedHolding = useMemo(() => {
    if (!detailSecurityId) return undefined;
    const current = holdings.find((holding) => holding.securityId === detailSecurityId);
    if (current) return current;
    const security = securityMap.get(detailSecurityId) ?? rawSecurityMap.get(detailSecurityId) ?? allSecurities.find((item) => item.id === detailSecurityId)
      ?? o.customSecurities.find((item) => item.id === detailSecurityId) ?? watchlist.find((item) => item.id === detailSecurityId)
      ?? (seed.securities as SearchSecurity[]).find((item) => item.id === detailSecurityId);
    if (!security) return undefined;
    // A watched or searched security that is not currently held.
    const rawSecurity = rawSecurityMap.get(detailSecurityId) ?? security;
    const nativeCurrency = rawSecurity.currency ?? (security as CurrencyCarrier)?.nativeCurrency ?? (isUsSecurity(security, detailSecurityId) ? "USD" : "JPY");
    const targetCurrency = displayCurrency === "NATIVE" ? nativeCurrency : displayCurrency;
    const convertedSecurity = securityMap.get(detailSecurityId);
    const detailReceipts = (displayCurrency === "NATIVE" ? nativeReceipts : allConvertedDividendReceipts).filter((receipt) => matchSecurityId(receipt.securityId, detailSecurityId));
    const result = calculateAverageCostPortfolio(detailTransactions, [displayCurrency === "NATIVE" ? rawSecurity : (convertedSecurity ?? security)], applicableCorporateActions, [], todayKey, detailReceipts);
    const quote = resolveQuote(quotes, detailSecurityId) ?? (security as { quote?: RemoteQuote }).quote;
    const currentPrice = displayCurrency === "NATIVE" ? (quote?.price ?? null) : (convertedSecurity?.quote?.price ?? (quote?.price != null ? convertAmount(quote.price, nativeCurrency, targetCurrency, currentUsdJpy) : null) ?? null);
    const previousClose = displayCurrency === "NATIVE" ? (quote?.previousRegularClose ?? null) : (convertedSecurity?.quote?.previousRegularClose ?? (quote?.previousRegularClose != null ? convertAmount(quote.previousRegularClose, nativeCurrency, targetCurrency, previousUsdJpy) : null) ?? null);
    const dayDiff = currentPrice != null && previousClose != null ? new Decimal(currentPrice).minus(previousClose).toString() : null;
    return {
      securityId: detailSecurityId, quantity: "0", totalCost: "0", averageCost: "0", currentPrice, marketValue: "0", unrealizedGain: "0",
      distributionIncome: result.distributionIncome ?? "0", realizedGain: result.realizedGain ?? "0", dayGain: dayDiff ?? "0",
      security: {
        ...security,
        currency: targetCurrency,
        nativeCurrency,
        quote: convertedSecurity?.quote ?? (quote && currentPrice != null ? { ...quote, price: currentPrice, ...(previousClose != null ? { previousRegularClose: previousClose } : {}) } : undefined),
      },
    };
  }, [allConvertedDividendReceipts, allSecurities, applicableCorporateActions, currentUsdJpy, detailSecurityId, detailTransactions, displayCurrency, holdings, nativeReceipts, o.customSecurities, previousUsdJpy, quotes, rawSecurityMap, securityMap, seed.securities, todayKey, watchlist]);

  return {
    currentUsdJpy: validCurrentUsdJpy,
    nativeMarketSecurities, rawSecurityMap, brokerOptions, summaryCurrency,
    portfolioNotifications, unreadNotificationCount, allTransactionSecurityIds,
    allRecognizedDistributions, allConvertedDividendReceipts, effectiveDividendCurrency, dividendFxUnavailable,
    historyCalculation, activeSummary, reconciliation, fxConversionReady, fxEstimated, valuationComplete,
    totalValue, dayGain, dayReturn, totalGain, totalReturn, holdings,
    convertedHistoryBars,
    verifiedPortfolioHistory: fxConversionReady && reconciliation.valid ? history : [],
    portfolioDateBounds, latestQuoteAt, marketSessions, selectedHolding, detailTransactions,
  };
}

/** Looks a quote up by ID or any equivalent ID spelling. */
export function resolveQuote(quotes: Record<string, RemoteQuote>, securityId: string): RemoteQuote | undefined {
  if (quotes[securityId]) return quotes[securityId];
  for (const variant of domainSecurityIdVariants(securityId)) if (quotes[variant]) return quotes[variant];
  return undefined;
}
