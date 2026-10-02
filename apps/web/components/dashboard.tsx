"use client";

import { fetchMarketResponse } from "@/lib/public-market-client";
import { BrowserPreferences, useBrowserPreferences } from "./browser-preferences";

import {
  calculateAverageCostPortfolio,
  calculateDividendIncome,
  canonicalDomainSecurityId,
  domainSecurityIdVariants,
  matchSecurityId,
  deriveSplitAdjustedTransactions,
  deriveTransactionPositionSnapshots,
  reconstructSecurityHistory,
  summarizeDividendReceipts,
  type CorporateAction,
  type DividendReceipt,
  type DistributionEvent,
  type IntradayBar,
  type LedgerTransaction,
  type MarketBar,
  type MarketQuote,
  type PortfolioHistoryPoint,
  type SecurityQuote,
} from "@kabutora/domain";
import AppLoadingScreen from "@/components/app-loading-screen";
import { getMarketAuthHeaders } from "@/lib/firebase-client";
import { readMarketCache, writeMarketCache, readCompactQuotesCache, writeCompactQuotesCache } from "@/lib/client-market-cache";
import { mergeIntradayBars, sanitizeIntradayBars } from "@/lib/intraday-cache";
import { quoteRefreshTargets, quoteSessionTransitionTargets } from "@/lib/market-refresh-plan";
import { earliestHistoryDate, inspectMarketHistory, packHistoryBars, unpackHistoryBars, type HistoryQuality, type PackedHistorySeries } from "@/lib/market-history";
import { buildHistoryFetchPlan, daysBetween, historyCoverage, MARKET_REQUEST_BATCH_SIZE, missingHistoryRequirements, splitSecurityIds } from "@/lib/market-fetch-plan";
import { readMarketApiResponse, stableMarketErrorMessage } from "@/lib/market-api-response";
import { loadServerMarketSnapshot, loadServerPtsIntraday, loadServerUsIntraday, refreshQueuedMarketData, syncServerMarketRegistry } from "@/lib/client-market-service";
import { timeoutSignal } from "@/lib/operation-deadline";
import { syncPageVisibilityDataset } from "@/lib/page-visibility";
import { RetainedView } from "./retained-view";
import { PortfolioHistoryCalculator } from "@/lib/domain-worker-client";
import { emptyPortfolioCalculation, type HistoryDataset, type PortfolioCalculationResult } from "@/lib/portfolio-history-calculation";
import type { DistributionCoverage, MarketDistributionBatchResult, ServerBenchmark, ServerMarketSnapshot, ServerRemoteQuote } from "@/lib/server-market-types";
import { mergeBenchmarks, mergeQuoteRecords } from "@/lib/market-snapshot-merge";
import { projectStockPortfolio, reconcilePortfolioParts } from "@/lib/portfolio-consistency";
import { historicalFxRateAtDate, historicalFxRateAtTimestamp } from "@/lib/historical-fx";
import { dynamicChartDomain } from "@/lib/chart-domain";
import { derivePortfolioNotifications, mergePortfolioNotifications, DEFAULT_PRICE_ALERT_PERCENT, PRICE_ALERT_THRESHOLDS, type ExternalMarketNotice, type PortfolioNotification } from "@/lib/portfolio-notifications";
import { portfolioMarketSessions, selectReliableMarketSessions, type MarketSessionStatus } from "@/lib/market-session";
import { resolveMarketClock, trustedMarketClockAnchor, type TrustedMarketClockAnchor } from "@/lib/market-clock";
import { latestIntradaySessionBars, marketDateKey, marketDateTimeLabel, marketSessionDateKey, marketTimeLabel, recentIntradaySessionBars, sanitizeDatedPoints, sparkline24HourBars, sparseIntradayTimeTicks, trailingHours } from "@/lib/chart-presentation";
import { calendarDateLabelJa, localDateInputValue, shiftCalendarMonths } from "@/lib/calendar-time";
import { compactNumber } from "@/lib/compact-number";
import { companyDisplayName, companyLegalName } from "@/lib/company-name";
import { normalizeRequestedSecurity } from "@/lib/market-security";
import { getEmbeddedCatalogSecurities } from "@/lib/stock-catalog";
import { isUsSecurity, portfolioFilterLabel, securityMatchesPortfolioFilter, shouldShowDailyFundTrend, type PortfolioFilter } from "@/lib/portfolio-filter";

import { adjacentTouchView, isInteractiveInputTarget, isSwipeBlockedTarget, resolveTouchAxis, shouldCommitNativeSwipe, shouldCommitSwipe } from "@/lib/touch-navigation";
import { Decimal } from "@kabutora/domain";
import { parseDecimalInput } from "@/lib/decimal-input";
import WatchlistView from "@/components/watchlist-view";
import {
  Activity,
  ArrowLeft,
  AlertTriangle,
  BarChart3,
  Bell,
  Bookmark,
  CalendarDays,
  Check,
  Coins,
  ChevronRight,
  Database,
  Download,
  Eye,
  EyeOff,
  FileClock,
  List,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Maximize2,
  Minimize2,
  Moon,
  Pencil,
  PieChart as PieChartIcon,
  Plus,
  RefreshCw,
  Search,
  RotateCcw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { memo, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Types
export type {
  Seed,
  RemoteQuote,
  MarketStatus,
  QuoteResponse,
  HistoryResponse,
  Benchmark,
  BenchmarkResponse,
  SearchSecurity,
  View,
  RangeKey,
  CustomDateRange,
  SecurityChartMode,
  UpdateFrequency,
  AccentTheme,
  DisplayCurrency,
  HistoryCacheMeta,
  FetchHealth,
  PackedIntradaySeries,
  MarketCachePayload,
  HistoryCachePayload,
  DistributionResponse,
  DistributionCachePayload,
  TouchGesture,
  SwipePhase,
  DataSecurityAction,
  DashboardProps,
} from "./dashboard/types";
import type {
  Seed,
  RemoteQuote,
  MarketStatus,
  QuoteResponse,
  Benchmark,
  BenchmarkResponse,
  HistoryResponse,
  DistributionResponse,
  SearchSecurity,
  View,
  RangeKey,
  CustomDateRange,
  AccentTheme,
  DisplayCurrency,
  HistoryCacheMeta,
  FetchHealth,
  PackedIntradaySeries,
  MarketCachePayload,
  HistoryCachePayload,
  DistributionCachePayload,
  TouchGesture,
  SwipePhase,
  DashboardProps,
  UpdateFrequency,
  UserPreferences,
} from "./dashboard/types";

// Constants
import {
  NAV_ITEMS,
  MOBILE_NAV_ITEMS,
  DESKTOP_TOUCH_NAVIGATION_ORDER,
  MOBILE_TOUCH_NAVIGATION_ORDER,
  MOBILE_VIEW_INDEX,
  PORTFOLIO_RANGES,
  UPDATE_FREQUENCIES,
  HISTORY_NETWORK_REVALIDATE_MS,
  HISTORY_INTEGRITY_CHECK_MS,
  PULL_REFRESH_THRESHOLD,
  PULL_REFRESH_MAX,
  PULL_REFRESH_HOLD_HEIGHT,
  TOUCH_NAVIGATION_LOCK_PX,
  SWIPE_SETTLE_MS,
  MOBILE_LAYOUT_QUERY,
  motionDuration,
  PERFORMANCE_DERIVATION_VERSION,
  FX_SECURITY_ID,
  MARKET_CACHE_KEY,
  HISTORY_CACHE_KEY,
  DISTRIBUTION_CACHE_KEY,
  DISTRIBUTION_NETWORK_REVALIDATE_MS,
  SUMMARY_AMOUNTS_VISIBLE_KEY,
  HIDE_SCROLLBAR_KEY,
  PRICE_ALERT_THRESHOLD_KEY,
  SUMMARY_MARKET_FILTER_KEY,
  LEGACY_MARKET_FILTER_KEY,
  SUMMARY_BROKER_FILTER_KEY,
  SUMMARY_RANGE_KEY,
  SUMMARY_CUSTOM_RANGE_KEY,
  DIVIDEND_MARKET_FILTER_KEY,
  DIVIDEND_DISPLAY_CURRENCY_KEY,
  DIVIDEND_PERIOD_KEY,
  DIVIDEND_TAX_MODE_KEY,
  DIVIDEND_TAB_KEY,
  HIDDEN_AMOUNT,
  LEGACY_MARKET_CACHE_KEYS,
  LEGACY_HISTORY_CACHE_KEYS,
  rangeLabel,
  freshnessLabel,
  seededActions,
  seededMarketNotices,
  notificationTypes,
  ALLOCATION_COLORS,
  ACCENT_THEMES,
} from "./dashboard/constants";

// Helpers
import {
  filterDatedHistory,
  number,
  benchmarkNumber,
  fxNumber,
  money,
  signedMoney,
  maybeMoney,
  maybeSignedMoney,
  signedPercent,
  timeJa,
  dateJa,
  shortDateTimeJa,
  costBasisGroupForAccount,
  isFundSecurity,
  isIndexSecurity,
  securityPriceUnit,
  securityQuantityUnit,
  securityPriceBasis,
  shortMoney,
  compactMoney,
  formatDayGainMoney,
  validUsdJpy,
  convertAmount,
  csvEscape,
  download,
  packIntradayBars,
  unpackIntradayBars,
  readStoredIds,
  readStoredNotifications,
  mergeActions,
  mergeDistributionEvents,
  latestMarketSessions,
  quoteTradeSourceLabel,
  quoteTimestampLabel,
  tickerQuoteTimestampLabel,
  pooledClientMap,
} from "./dashboard/helpers";

// Subcomponents
import { FastOverview } from "./dashboard/overview-view";
import { FastDividendsView } from "./dashboard/dividends-view";
import { SecurityDetailView } from "./dashboard/security-detail-view";
import { FastActivityView } from "./dashboard/activity-view";
import { FastNotificationsView } from "./dashboard/notifications-view";
import { FastSettingsView } from "./dashboard/settings-view";
import { UpdatingBanner } from "./dashboard/updating-banner";
import { TradeModal } from "./dashboard/trade-modal";
import { DeleteTransactionDialog } from "./dashboard/delete-transaction-dialog";
import { RemoveAccountDialog } from "./dashboard/remove-account-dialog";

function Brand() {
  return (
    <div className="brand" aria-label="株トラ">
      <img src="/kabutora-logo.png" alt="" className="brand-logo" width="26" height="26" />
      <strong>株トラ</strong>
    </div>
  );
}

function resolveQuoteFromRecord(quotes: Record<string, RemoteQuote>, securityId: string): RemoteQuote | undefined {
  if (quotes[securityId]) return quotes[securityId];
  for (const variant of domainSecurityIdVariants(securityId)) {
    if (quotes[variant]) return quotes[variant];
  }
  return undefined;
}

const FastWatchlistView = memo(WatchlistView);

export default function Dashboard(props: DashboardProps) {
  return <BrowserPreferences persistent={props.allowPersistentMarketCache !== false} namespace={props.preferenceNamespace}><DashboardContents {...props}/></BrowserPreferences>;
}

function resolveInitialPreferences(seed: Seed, preferenceStorage: Storage) {
  const savedTheme = preferenceStorage.getItem("kabutora-theme");
  const savedAccent = preferenceStorage.getItem("kabutora-accent") as AccentTheme | null;
  const savedAutoRefresh = preferenceStorage.getItem("kabutora-auto-refresh");
  const savedUpdateFrequency = Number(preferenceStorage.getItem("kabutora-update-frequency"));
  const savedDisplayCurrency = preferenceStorage.getItem("kabutora-display-currency") as DisplayCurrency | null;
  const savedSummaryMarketFilter = (preferenceStorage.getItem(SUMMARY_MARKET_FILTER_KEY) ?? preferenceStorage.getItem(LEGACY_MARKET_FILTER_KEY)) as PortfolioFilter | null;
  const savedSummaryBrokerFilter = preferenceStorage.getItem(SUMMARY_BROKER_FILTER_KEY);
  const savedDividendMarketFilter = preferenceStorage.getItem(DIVIDEND_MARKET_FILTER_KEY) as PortfolioFilter | null;
  const savedDividendDisplayCurrency = preferenceStorage.getItem(DIVIDEND_DISPLAY_CURRENCY_KEY) as DisplayCurrency | null;
  const savedDividendPeriod = preferenceStorage.getItem(DIVIDEND_PERIOD_KEY);
  const savedDividendTaxMode = preferenceStorage.getItem(DIVIDEND_TAX_MODE_KEY) as "gross" | "net" | null;
  const savedDividendTab = preferenceStorage.getItem(DIVIDEND_TAB_KEY) as "securities" | "history" | null;
  const savedSummaryAmountsVisible = preferenceStorage.getItem(SUMMARY_AMOUNTS_VISIBLE_KEY);
  const savedHideScrollbar = preferenceStorage.getItem(HIDE_SCROLLBAR_KEY);
  const savedSummaryRange = preferenceStorage.getItem(SUMMARY_RANGE_KEY) as RangeKey | null;
  const savedSummaryCustomRange = preferenceStorage.getItem(SUMMARY_CUSTOM_RANGE_KEY);
  const savedPriceAlertThreshold = Number(preferenceStorage.getItem(PRICE_ALERT_THRESHOLD_KEY));
  const savedAcknowledgedActions = readStoredIds(preferenceStorage, "kabutora-acknowledged-actions-v1");
  const savedReadNotifications = readStoredIds(preferenceStorage, "kabutora-read-notifications-v1");
  const savedNotificationHistory = readStoredNotifications(preferenceStorage);
  const savedWatchlist = preferenceStorage.getItem("kabutora-watchlist-v1");

  const cloudWatchlist = seed.watchlist;
  const cloudPreferences = seed.preferences;

  let resolvedWatchlist: SearchSecurity[] = seed.watchlist ?? [];
  if (cloudWatchlist && Array.isArray(cloudWatchlist) && cloudWatchlist.length > 0) {
    resolvedWatchlist = cloudWatchlist;
  } else if (savedWatchlist) {
    try {
      const parsed = JSON.parse(savedWatchlist) as SearchSecurity[];
      if (Array.isArray(parsed) && parsed.length > 0) resolvedWatchlist = parsed;
    } catch {}
  }

  const pTheme = cloudPreferences?.theme ?? savedTheme;
  const dark = pTheme === "dark";
  const accentTheme = cloudPreferences?.accentTheme ?? (savedAccent && ["graphite", "blue", "forest", "plum"].includes(savedAccent) ? savedAccent : "graphite");
  const autoRefresh = cloudPreferences?.autoRefresh ?? (savedAutoRefresh !== "false");
  const updateFrequency = (cloudPreferences?.updateFrequency ?? (savedUpdateFrequency && [10, 15, 30, 60].includes(savedUpdateFrequency) ? savedUpdateFrequency : 15)) as UpdateFrequency;
  const priceAlertThreshold = cloudPreferences?.priceAlertThreshold ?? (savedPriceAlertThreshold && (PRICE_ALERT_THRESHOLDS as readonly number[]).includes(savedPriceAlertThreshold) ? savedPriceAlertThreshold : DEFAULT_PRICE_ALERT_PERCENT);
  const displayCurrency = cloudPreferences?.displayCurrency ?? (savedDisplayCurrency && ["JPY", "USD", "NATIVE"].includes(savedDisplayCurrency) ? savedDisplayCurrency : (seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY"));
  const summaryMarketFilter = cloudPreferences?.summaryMarketFilter ?? (savedSummaryMarketFilter && ["ALL", "JP", "US", "FUNDS_INDEXES"].includes(savedSummaryMarketFilter) ? savedSummaryMarketFilter : "ALL");
  const summaryBrokerFilter = cloudPreferences?.summaryBrokerFilter ?? (savedSummaryBrokerFilter || "ALL");
  const dividendMarketFilter = cloudPreferences?.dividendMarketFilter ?? (savedDividendMarketFilter && ["ALL", "JP", "US", "FUNDS_INDEXES"].includes(savedDividendMarketFilter) ? savedDividendMarketFilter : "ALL");
  const dividendDisplayCurrency = cloudPreferences?.dividendDisplayCurrency ?? (savedDividendDisplayCurrency && ["JPY", "USD", "NATIVE"].includes(savedDividendDisplayCurrency) ? savedDividendDisplayCurrency : (seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY"));
  const dividendPeriod = cloudPreferences?.dividendPeriod ?? (savedDividendPeriod || "ALL");
  const dividendTaxMode = cloudPreferences?.dividendTaxMode ?? (savedDividendTaxMode && (savedDividendTaxMode === "gross" || savedDividendTaxMode === "net") ? savedDividendTaxMode : "gross");
  const dividendActiveTab = cloudPreferences?.dividendActiveTab ?? (savedDividendTab && (savedDividendTab === "securities" || savedDividendTab === "history") ? savedDividendTab : "securities");
  const range = cloudPreferences?.summaryRange ?? (savedSummaryRange && (PORTFOLIO_RANGES.includes(savedSummaryRange) || savedSummaryRange === "CUSTOM") ? savedSummaryRange : "ALL");

  let customRange: CustomDateRange | null = null;
  if (cloudPreferences?.summaryCustomRange) {
    customRange = cloudPreferences.summaryCustomRange;
  } else if (savedSummaryCustomRange) {
    try {
      const parsed = JSON.parse(savedSummaryCustomRange) as CustomDateRange;
      if (parsed && typeof parsed.from === "string" && typeof parsed.to === "string") customRange = parsed;
    } catch {}
  }

  const summaryAmountsVisible = cloudPreferences?.summaryAmountsVisible ?? (savedSummaryAmountsVisible !== "false");
  const hideScrollbar = cloudPreferences?.hideScrollbar ?? (savedHideScrollbar !== "false");
  const acknowledgedActionIds = [...new Set([...(savedAcknowledgedActions ?? []), ...(cloudPreferences?.acknowledgedActions ?? [])])];
  const readNotificationIds = [...new Set([...(savedReadNotifications ?? []), ...(cloudPreferences?.readNotifications ?? [])])];
  const notificationHistory = cloudPreferences?.notificationHistory ?? savedNotificationHistory;

  return {
    watchlist: resolvedWatchlist,
    dark,
    accentTheme,
    autoRefresh,
    updateFrequency,
    priceAlertThreshold,
    displayCurrency,
    summaryMarketFilter,
    summaryBrokerFilter,
    dividendMarketFilter,
    dividendDisplayCurrency,
    dividendPeriod,
    dividendTaxMode,
    dividendActiveTab,
    range,
    customRange,
    summaryAmountsVisible,
    hideScrollbar,
    acknowledgedActionIds,
    readNotificationIds,
    notificationHistory,
    cloudPreferences,
    savedTheme,
    savedDisplayCurrency,
    savedAccent,
    savedAutoRefresh,
    pTheme,
  };
}

function DashboardContents({
  seed,
  initialServerTimeMs,
  initialMarketSessions = [],
  initialMarketSnapshot,
  persistenceMode = "local",
  onTransactionsChange,
  onAccountsChange,
  onSecuritiesChange,
  onWatchlistChange,
  onPreferencesChange,
  onEncryptedBackup,
  onRestoreBackup,
  allowPlaintextExport = true,
  allowPersistentMarketCache = true,
  preferenceNamespace,
  onLock,
  onLogout,
  onStartupReady,
}: DashboardProps) {
  const preferenceStorage = useBrowserPreferences();
  const initialPreferences = useMemo(() => resolveInitialPreferences(seed, preferenceStorage), [preferenceStorage, seed]);
  const [view, setView] = useState<View>("overview");
  const renderedView = view;
  const activeViewRef = useRef<View>(view);
  const detailReturnViewRef = useRef<View>("overview");
  const [detailReturnView, setDetailReturnView] = useState<View>("overview");
  const [mountedViews, setMountedViews] = useState<Set<View>>(() => new Set<View>(["overview"]));
  const [watchlist, setWatchlist] = useState<SearchSecurity[]>(initialPreferences.watchlist);
  const [range, setRange] = useState<RangeKey>(initialPreferences.range);
  const [customRange, setCustomRange] = useState<CustomDateRange | null>(initialPreferences.customRange);
  const [dark, setDark] = useState(initialPreferences.dark);
  const [accentTheme, setAccentTheme] = useState<AccentTheme>(initialPreferences.accentTheme);
  const [tradeOpen, setTradeOpen] = useState(false);
  const [transactions, setTransactions] = useState<Seed["transactions"]>(seed.transactions);
  const [accounts, setAccounts] = useState<Seed["accounts"]>(seed.accounts);
  const [summaryBrokerFilter, setSummaryBrokerFilter] = useState(initialPreferences.summaryBrokerFilter);
  const [summaryMarketFilter, setSummaryMarketFilter] = useState<PortfolioFilter>(initialPreferences.summaryMarketFilter);
  const calculationBrokerFilter = useDeferredValue(summaryBrokerFilter);
  const calculationMarketFilter = useDeferredValue(summaryMarketFilter);
  const [dividendMarketFilter, setDividendMarketFilter] = useState<PortfolioFilter>(initialPreferences.dividendMarketFilter);
  const [dividendDisplayCurrency, setDividendDisplayCurrency] = useState<DisplayCurrency>(initialPreferences.dividendDisplayCurrency);
  const [dividendPeriod, setDividendPeriod] = useState<string>(initialPreferences.dividendPeriod);
  const [dividendTaxMode, setDividendTaxMode] = useState<"gross" | "net">(initialPreferences.dividendTaxMode);
  const [dividendActiveTab, setDividendActiveTab] = useState<"securities" | "history">(initialPreferences.dividendActiveTab);
  const [summaryAmountsVisible, setSummaryAmountsVisible] = useState(initialPreferences.summaryAmountsVisible);
  const [hideScrollbar, setHideScrollbar] = useState(initialPreferences.hideScrollbar);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(initialPreferences.displayCurrency);

  const [customSecurities, setCustomSecurities] = useState<SearchSecurity[]>([]);
  const [toast, setToast] = useState("");
  const [editingTransaction, setEditingTransaction] = useState<Seed["transactions"][number] | null>(null);
  const [pendingDeleteTransaction, setPendingDeleteTransaction] = useState<Seed["transactions"][number] | null>(null);
  const [pendingRemoveAccountId, setPendingRemoveAccountId] = useState<string | null>(null);
  const [selectedSecurity, setSelectedSecurity] = useState(seed.securities[0]?.id ?? "");
  const [detailSecurityId, setDetailSecurityId] = useState(seed.securities[0]?.id ?? "");
  const [tradeType, setTradeType] = useState<"BUY" | "SELL">("BUY");
  const [tradeQuantity, setTradeQuantity] = useState("");
  const [tradePrice, setTradePrice] = useState("");
  const [tradeDate, setTradeDate] = useState(() => localDateInputValue());
  const [selectedAccountId, setSelectedAccountId] = useState(seed.accounts.find((account) => account.broker !== "現金口座")?.id ?? seed.accounts[0]?.id ?? "");
  const [customBroker, setCustomBroker] = useState("");
  const [tradeSearchActive, setTradeSearchActive] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, RemoteQuote>>(() => {
    const fromSnapshot = Object.fromEntries((initialMarketSnapshot?.quotes ?? []).map((quote) => [quote.securityId, quote]));
    if (Object.keys(fromSnapshot).length) return fromSnapshot;
    if (allowPersistentMarketCache) {
      return readCompactQuotesCache();
    }
    return {};
  });
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>(() => initialMarketSnapshot?.benchmarks ?? []);
  const [intradayBars, setIntradayBars] = useState<IntradayBar[]>(() => initialMarketSnapshot?.intraday ? sanitizeIntradayBars(initialMarketSnapshot.intraday) : []);
  const [historyBars, setHistoryBars] = useState<MarketBar[]>([]);
  const [historyInceptionDates, setHistoryInceptionDates] = useState<Record<string, string>>({});
  const [corporateActions, setCorporateActions] = useState<CorporateAction[]>(seededActions);
  const [distributions, setDistributions] = useState<DistributionEvent[]>([]);
  const [distributionCoverage, setDistributionCoverage] = useState<DistributionCoverage[]>([]);
  const [distributionStatus, setDistributionStatus] = useState<MarketStatus>("idle");
  const [distributionError, setDistributionError] = useState("");
  const [distributionCacheSavedAt, setDistributionCacheSavedAt] = useState("");
  const [quoteStatus, setQuoteStatus] = useState<MarketStatus>(() => {
    if (initialMarketSnapshot?.quotes.length) {
      return initialMarketSnapshot.refresh.status === "ready" ? "ready" : "partial";
    }
    if (allowPersistentMarketCache && typeof window !== "undefined" && Object.keys(readCompactQuotesCache()).length) {
      return "partial";
    }
    return "loading";
  });
  const [benchmarkStatus, setBenchmarkStatus] = useState<MarketStatus>(initialMarketSnapshot?.benchmarks.length ? "ready" : "loading");
  const [marketStartupReady, setMarketStartupReady] = useState(true);
  const [startupCoverVisible, setStartupCoverVisible] = useState(false);
  const [startupCoverExiting, setStartupCoverExiting] = useState(true);
  const [historyStatus, setHistoryStatus] = useState<MarketStatus>("idle");
  const [historyRequested, setHistoryRequested] = useState(false);
  const [historyQuality, setHistoryQuality] = useState<HistoryQuality | null>(null);
  const [historyCacheMeta, setHistoryCacheMeta] = useState<HistoryCacheMeta | null>(null);
  const [acknowledgedActionIds, setAcknowledgedActionIds] = useState<string[]>(initialPreferences.acknowledgedActionIds);
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>(initialPreferences.readNotificationIds);
  const [notificationHistory, setNotificationHistory] = useState<PortfolioNotification[]>(initialPreferences.notificationHistory);
  const [autoRefresh, setAutoRefresh] = useState(initialPreferences.autoRefresh);
  const [updateFrequency, setUpdateFrequency] = useState<UpdateFrequency>(initialPreferences.updateFrequency);
  const [priceAlertThreshold, setPriceAlertThreshold] = useState<number>(initialPreferences.priceAlertThreshold);
  const [marketError, setMarketError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [quoteHealth, setQuoteHealth] = useState<FetchHealth>({ requested: 0, returned: 0, failedIds: [], fallbackIds: [], updatedAt: null });
  const [historyHealth, setHistoryHealth] = useState<FetchHealth>({ requested: 0, returned: 0, failedIds: [], fallbackIds: [], updatedAt: null });
  const [hydrated, setHydrated] = useState(true);

  const lastLocalPrefTimestampRef = useRef<number>(0);
  const localPrefTimestampsRef = useRef<Partial<Record<keyof UserPreferences, number>>>({});

  const markLocalPrefEdit = useCallback((key: keyof UserPreferences) => {
    const now = Date.now();
    lastLocalPrefTimestampRef.current = now;
    localPrefTimestampsRef.current[key] = now;
  }, []);

  const handleRangeChange = useCallback((nextRange: RangeKey) => {
    markLocalPrefEdit("summaryRange");
    setRange(nextRange);
  }, [markLocalPrefEdit]);

  const handleCustomRangeChange = useCallback((nextCustomRange: CustomDateRange | null) => {
    markLocalPrefEdit("summaryCustomRange");
    setCustomRange(nextCustomRange);
  }, [markLocalPrefEdit]);

  const handleSummaryAmountsVisibleChange = useCallback((visible: boolean | ((prev: boolean) => boolean)) => {
    markLocalPrefEdit("summaryAmountsVisible");
    setSummaryAmountsVisible(visible);
  }, [markLocalPrefEdit]);

  const handleSummaryBrokerFilterChange = useCallback((broker: string | ((prev: string) => string)) => {
    markLocalPrefEdit("summaryBrokerFilter");
    setSummaryBrokerFilter(broker);
  }, [markLocalPrefEdit]);

  const handleSummaryMarketFilterChange = useCallback((nextFilter: PortfolioFilter) => {
    markLocalPrefEdit("summaryMarketFilter");
    setSummaryMarketFilter(nextFilter);
  }, [markLocalPrefEdit]);

  const handleDividendMarketFilterChange = useCallback((nextFilter: PortfolioFilter) => {
    markLocalPrefEdit("dividendMarketFilter");
    setDividendMarketFilter(nextFilter);
  }, [markLocalPrefEdit]);

  const handleDividendDisplayCurrencyChange = useCallback((nextCurr: DisplayCurrency | ((prev: DisplayCurrency) => DisplayCurrency)) => {
    markLocalPrefEdit("dividendDisplayCurrency");
    setDividendDisplayCurrency(nextCurr);
  }, [markLocalPrefEdit]);

  const handleDividendPeriodChange = useCallback((nextPeriod: string | ((prev: string) => string)) => {
    markLocalPrefEdit("dividendPeriod");
    setDividendPeriod(nextPeriod);
  }, [markLocalPrefEdit]);

  const handleDividendTaxModeChange = useCallback((nextMode: "gross" | "net" | ((prev: "gross" | "net") => "gross" | "net")) => {
    markLocalPrefEdit("dividendTaxMode");
    setDividendTaxMode(nextMode);
  }, [markLocalPrefEdit]);

  const handleDividendActiveTabChange = useCallback((nextTab: "securities" | "history" | ((prev: "securities" | "history") => "securities" | "history")) => {
    markLocalPrefEdit("dividendActiveTab");
    setDividendActiveTab(nextTab);
  }, [markLocalPrefEdit]);

  const handleDarkChange = useCallback((nextDark: boolean | ((prev: boolean) => boolean)) => {
    markLocalPrefEdit("theme");
    setDark(nextDark);
  }, [markLocalPrefEdit]);

  const handleAccentThemeChange = useCallback((nextAccent: AccentTheme | ((prev: AccentTheme) => AccentTheme)) => {
    markLocalPrefEdit("accentTheme");
    setAccentTheme(nextAccent);
  }, [markLocalPrefEdit]);

  const handleAutoRefreshChange = useCallback((nextAutoRefresh: boolean | ((prev: boolean) => boolean)) => {
    markLocalPrefEdit("autoRefresh");
    setAutoRefresh(nextAutoRefresh);
  }, [markLocalPrefEdit]);

  const handleUpdateFrequencyChange = useCallback((nextFreq: UpdateFrequency | ((prev: UpdateFrequency) => UpdateFrequency)) => {
    markLocalPrefEdit("updateFrequency");
    setUpdateFrequency(nextFreq);
  }, [markLocalPrefEdit]);

  const handleHideScrollbarChange = useCallback((nextHide: boolean | ((prev: boolean) => boolean)) => {
    markLocalPrefEdit("hideScrollbar");
    setHideScrollbar(nextHide);
  }, [markLocalPrefEdit]);

  const handleDisplayCurrencyChange = useCallback((nextCurr: DisplayCurrency | ((prev: DisplayCurrency) => DisplayCurrency)) => {
    markLocalPrefEdit("displayCurrency");
    setDisplayCurrency(nextCurr);
  }, [markLocalPrefEdit]);

  const handlePriceAlertThresholdChange = useCallback((nextThresh: number | ((prev: number) => number)) => {
    markLocalPrefEdit("priceAlertThreshold");
    setPriceAlertThreshold(nextThresh);
  }, [markLocalPrefEdit]);
  const initialClockMs = Number.isFinite(initialServerTimeMs) ? initialServerTimeMs! : Date.now();
  const [sessionClock, setSessionClock] = useState<number | null>(() => Number.isFinite(initialClockMs) ? initialClockMs : null);
  const [serverMarketSessions, setServerMarketSessions] = useState<MarketSessionStatus[]>(initialMarketSessions);
  const [apiUsage, setApiUsage] = useState({ quoteRequests: 0, benchmarkRequests: 0, historyRequests: 0, searchRequests: 0, historyCacheHits: 0, integrityChecks: 0, lastQuoteRequest: null as string | null, lastBenchmarkRequest: null as string | null, lastHistoryRequest: null as string | null, lastSearchRequest: null as string | null });
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const touchGesture = useRef<TouchGesture | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const marketViewsPreloadedRef = useRef(false);
  const pullBannerRef = useRef<HTMLDivElement | null>(null);
  const pullIconRef = useRef<SVGSVGElement | null>(null);
  const pullTextRef = useRef<HTMLSpanElement | null>(null);
  const pullDistanceRef = useRef(0);
  const viewScrollPositionsRef = useRef<Partial<Record<View, number>>>({});
  const viewportSyncFrameRef = useRef<number | null>(null);
  const manualRefreshInFlight = useRef<Promise<void> | null>(null);
  const quoteRequestInFlight = useRef(false);
  const benchmarkRequestInFlight = useRef(false);
  const quoteReloadPending = useRef(false);
  const quoteReloadTimerRef = useRef<number | null>(null);
  const lastQuoteRequestAtRef = useRef(0);
  const prevRangeViewRef = useRef<string>("");
  const [quoteRefreshToken, setQuoteRefreshToken] = useState(0);
  const quotesRef = useRef(quotes);
  const benchmarksRef = useRef(benchmarks);
  const intradayBarsRef = useRef(intradayBars);
  const historyBarsRef = useRef(historyBars);
  const historyInceptionDatesRef = useRef(historyInceptionDates);
  const corporateActionsRef = useRef(corporateActions);
  const historyCacheMetaRef = useRef(historyCacheMeta);
  historyBarsRef.current = historyBars;
  historyInceptionDatesRef.current = historyInceptionDates;
  corporateActionsRef.current = corporateActions;
  historyCacheMetaRef.current = historyCacheMeta;
  const historyRequestInFlight = useRef(false);
  const historyReloadPending = useRef(false);
  const distributionRequestInFlight = useRef(false);
  const distributionReloadPending = useRef(false);
  const distributionAttemptKey = useRef("");
  const historyRequirementKey = useRef("");
  const lastManualRefreshAt = useRef(0);
  const marketStartupRunRef = useRef(false);
  const quoteEffectKeyRef = useRef("");
  const sessionClockRef = useRef(sessionClock);
  const trustedClockRef = useRef<TrustedMarketClockAnchor | null>(trustedMarketClockAnchor(
    initialServerTimeMs ?? Number.NaN,
    typeof performance === "undefined" ? 0 : performance.now(),
  ));

  const updatePullVisuals = useCallback((distance: number, isRefreshing: boolean, animated: boolean) => {
    const workspace = workspaceRef.current;
    const banner = pullBannerRef.current;
    const icon = pullIconRef.current;
    const text = pullTextRef.current;

    const offset = isRefreshing ? 0 : distance;
    const isReady = distance >= PULL_REFRESH_THRESHOLD;
    const isVisible = distance >= 4 || isRefreshing;

    if (workspace) {
      workspace.style.transition = animated ? "transform 0.28s cubic-bezier(0.18, 0.9, 0.32, 1)" : "none";
      workspace.style.transform = offset > 0 ? `translate3d(0, ${offset}px, 0)` : "";
    }

    if (banner) {
      banner.style.transition = animated ? "transform 0.28s cubic-bezier(0.18, 0.9, 0.32, 1), opacity 0.18s ease" : "none";
      banner.style.opacity = isVisible ? "1" : "0";
      const bannerY = isRefreshing ? 6 : Math.max(-48, Math.round(distance * 0.64 - 36));
      banner.style.transform = `translate3d(-50%, ${bannerY}px, 0)`;
      banner.dataset.visible = isVisible ? "true" : "false";
      banner.dataset.ready = isReady ? "true" : "false";
      banner.dataset.refreshing = isRefreshing ? "true" : "false";
    }

    if (icon && !isRefreshing) {
      const rotation = Math.min(360, Math.round((distance / PULL_REFRESH_THRESHOLD) * 360));
      icon.style.transform = `rotate(${rotation}deg)`;
    }

    if (text) {
      text.textContent = isRefreshing
        ? "市場データを更新中…"
        : isReady
        ? "離して更新"
        : "引いて更新";
    }
  }, []);

  const rememberActiveViewScroll = useCallback(() => {
    viewScrollPositionsRef.current[activeViewRef.current] = window.scrollY;
  }, []);

  const navigateToView = useCallback((target: View, restorePosition = true) => {
    const resolvedTarget = target === "performance" ? "overview" : target;
    if (resolvedTarget === activeViewRef.current) return;
    rememberActiveViewScroll();
    if (!restorePosition) viewScrollPositionsRef.current[resolvedTarget] = 0;
    activeViewRef.current = resolvedTarget;
    setMountedViews((current) => {
      if (current.has(resolvedTarget)) return current;
      const next = new Set(current);
      next.add(resolvedTarget);
      return next;
    });
    setView(resolvedTarget);
  }, [rememberActiveViewScroll]);

  useEffect(() => { activeViewRef.current = view; }, [view]);
  useEffect(() => {
    const visualViewport = window.visualViewport;
    const syncViewport = () => {
      if (viewportSyncFrameRef.current != null) window.cancelAnimationFrame(viewportSyncFrameRef.current);
      viewportSyncFrameRef.current = window.requestAnimationFrame(() => {
        viewportSyncFrameRef.current = null;
        const shell = appShellRef.current;
        if (!shell) return;
        if (!window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
          shell.style.removeProperty("--app-viewport-height");
          shell.style.removeProperty("--app-viewport-top");
          return;
        }
        const isKeyboard = visualViewport ? visualViewport.height < window.innerHeight - 80 : false;
        if (isKeyboard && visualViewport) {
          const viewportTop = Math.floor(visualViewport.offsetTop ?? 0);
          const viewportBottom = Math.ceil((visualViewport.offsetTop ?? 0) + visualViewport.height);
          shell.style.setProperty("--app-viewport-height", `${viewportBottom - viewportTop}px`);
          shell.style.setProperty("--app-viewport-top", `${viewportTop}px`);
        } else {
          shell.style.removeProperty("--app-viewport-height");
          shell.style.removeProperty("--app-viewport-top");
        }
      });
    };
    syncViewport();
    visualViewport?.addEventListener("resize", syncViewport, { passive: true });
    visualViewport?.addEventListener("scroll", syncViewport, { passive: true });
    window.addEventListener("resize", syncViewport, { passive: true });
    window.addEventListener("orientationchange", syncViewport, { passive: true });
    return () => {
      visualViewport?.removeEventListener("resize", syncViewport);
      visualViewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      if (viewportSyncFrameRef.current != null) window.cancelAnimationFrame(viewportSyncFrameRef.current);
    };
  }, [hydrated, marketStartupReady]);


  const acceptTrustedServerTime = useCallback((value: string | undefined) => {
    if (!value) return;
    const serverMs = Date.parse(value);
    if (!Number.isFinite(serverMs)) return;
    trustedClockRef.current = trustedMarketClockAnchor(serverMs, typeof performance === "undefined" ? 0 : performance.now());
    sessionClockRef.current = serverMs;
    setSessionClock(serverMs);
  }, []);

  const logQuotesToHistory = useCallback((incomingQuotes: RemoteQuote[]) => {
    if (!incomingQuotes.length) return;
    const currentBars = historyBarsRef.current;
    if (!currentBars.length) return;
    const latestBarBySecurity = new Map<string, MarketBar>();
    const barBySecurityDate = new Map<string, MarketBar>();
    for (const bar of currentBars) {
      barBySecurityDate.set(`${bar.securityId}:${bar.date}`, bar);
      const prev = latestBarBySecurity.get(bar.securityId);
      if (!prev || bar.date > prev.date) {
        latestBarBySecurity.set(bar.securityId, bar);
      }
    }
    const quoteBars: MarketBar[] = [];

    for (const quote of incomingQuotes) {
      if (quote.validationStatus === "rejected") continue;
      const dateKey = quote.marketTimestamp
        ? (marketDateKey(quote.marketTimestamp, quote.exchangeMic, undefined, quote.currency, quote.venueCode === "US" ? "US" : "JP") || quote.marketTimestamp.slice(0, 10))
        : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      const priceNum = Number(quote.price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) continue;

      const targetIds = [quote.securityId, ...domainSecurityIdVariants(quote.securityId)];
      for (const secId of new Set(targetIds)) {
        const latest = latestBarBySecurity.get(secId);
        if (!latest) continue;
        const diff = daysBetween(latest.date, dateKey);
        if (diff > 5) continue;

        const existing = barBySecurityDate.get(`${secId}:${dateKey}`);
        if (!existing || existing.provider === "quote_log") {
          quoteBars.push({
            securityId: secId,
            date: dateKey,
            close: quote.price,
            adjustedClose: quote.price,
            provider: "quote_log",
          });
        }
      }
    }

    if (quoteBars.length > 0) {
      const inspected = inspectMarketHistory(currentBars, quoteBars, corporateActionsRef.current);
      if (inspected.bars.length !== currentBars.length || inspected.quality.checksum !== historyCacheMetaRef.current?.checksum) {
        historyBarsRef.current = inspected.bars;
        setHistoryBars(inspected.bars);
        setHistoryQuality(inspected.quality);
        const savedAt = new Date().toISOString();
        const nextMeta: HistoryCacheMeta = { savedAt, checksum: inspected.quality.checksum };
        historyCacheMetaRef.current = nextMeta;
        setHistoryCacheMeta(nextMeta);
        if (allowPersistentMarketCache) {
          void writeMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, {
            schemaVersion: 11,
            derivationVersion: PERFORMANCE_DERIVATION_VERSION,
            savedAt,
            checksum: inspected.quality.checksum,
            series: packHistoryBars(inspected.bars),
            corporateActions: inspected.actions,
            inceptionDates: historyInceptionDatesRef.current,
          }, LEGACY_HISTORY_CACHE_KEYS);
        }
      }
    }
  }, [allowPersistentMarketCache]);

  const applyServerMarketSnapshot = useCallback((snapshot: ServerMarketSnapshot) => {
    if (!snapshot.quotes.length) return false;
    const incomingQuotes: Record<string, RemoteQuote> = {};
    for (const quote of snapshot.quotes) {
      incomingQuotes[quote.securityId] = quote;
      for (const variant of domainSecurityIdVariants(quote.securityId)) {
        if (!incomingQuotes[variant]) {
          incomingQuotes[variant] = { ...quote, securityId: variant };
        }
      }
    }
    const incomingIntraday: IntradayBar[] = [];
    for (const bar of snapshot.intraday) {
      incomingIntraday.push(bar);
      for (const variant of domainSecurityIdVariants(bar.securityId)) {
        if (variant !== bar.securityId) {
          incomingIntraday.push({ ...bar, securityId: variant });
        }
      }
    }
    const mergedQuotes = mergeQuoteRecords(quotesRef.current, incomingQuotes);
    const mergedBenchmarks = mergeBenchmarks(benchmarksRef.current, snapshot.benchmarks);
    const mergedIntraday = mergeIntradayBars(intradayBarsRef.current, incomingIntraday);
    quotesRef.current = mergedQuotes;
    benchmarksRef.current = mergedBenchmarks;
    intradayBarsRef.current = mergedIntraday;
    setQuotes(mergedQuotes);
    setBenchmarks(mergedBenchmarks);
    setIntradayBars(mergedIntraday);
    logQuotesToHistory(snapshot.quotes);
    setQuoteStatus(snapshot.refresh.status === "ready" ? "ready" : "partial");
    setBenchmarkStatus(mergedBenchmarks.length ? "ready" : "partial");
    setQuoteHealth({
      requested: snapshot.coverage.registered,
      returned: snapshot.coverage.quoted,
      failedIds: [],
      fallbackIds: [],
      updatedAt: snapshot.savedAt,
    });
    if (snapshot.marketSessions.length) setServerMarketSessions(snapshot.marketSessions);
    acceptTrustedServerTime(snapshot.generatedAt);
    setMarketStartupReady(true);
    return true;
  }, [acceptTrustedServerTime, logQuotesToHistory]);

  useEffect(() => {
    if (initialMarketSnapshot) applyServerMarketSnapshot(initialMarketSnapshot);
  }, [applyServerMarketSnapshot, initialMarketSnapshot]);

  useEffect(() => {
    const savedTheme = preferenceStorage.getItem("kabutora-theme");
    const savedAccent = preferenceStorage.getItem("kabutora-accent") as AccentTheme | null;
    const savedAutoRefresh = preferenceStorage.getItem("kabutora-auto-refresh");
    const savedUpdateFrequency = Number(preferenceStorage.getItem("kabutora-update-frequency"));
    const savedDisplayCurrency = preferenceStorage.getItem("kabutora-display-currency") as DisplayCurrency | null;
    const savedSummaryMarketFilter = (preferenceStorage.getItem(SUMMARY_MARKET_FILTER_KEY) ?? preferenceStorage.getItem(LEGACY_MARKET_FILTER_KEY)) as PortfolioFilter | null;
    const savedSummaryBrokerFilter = preferenceStorage.getItem(SUMMARY_BROKER_FILTER_KEY);
    const savedDividendMarketFilter = preferenceStorage.getItem(DIVIDEND_MARKET_FILTER_KEY) as PortfolioFilter | null;
    const savedDividendDisplayCurrency = preferenceStorage.getItem(DIVIDEND_DISPLAY_CURRENCY_KEY) as DisplayCurrency | null;
    const savedDividendPeriod = preferenceStorage.getItem(DIVIDEND_PERIOD_KEY);
    const savedDividendTaxMode = preferenceStorage.getItem(DIVIDEND_TAX_MODE_KEY) as "gross" | "net" | null;
    const savedDividendTab = preferenceStorage.getItem(DIVIDEND_TAB_KEY) as "securities" | "history" | null;
    const savedSummaryAmountsVisible = preferenceStorage.getItem(SUMMARY_AMOUNTS_VISIBLE_KEY);
    const savedHideScrollbar = preferenceStorage.getItem(HIDE_SCROLLBAR_KEY);
    const savedSummaryRange = preferenceStorage.getItem(SUMMARY_RANGE_KEY) as RangeKey | null;
    const savedSummaryCustomRange = preferenceStorage.getItem(SUMMARY_CUSTOM_RANGE_KEY);
    const savedPriceAlertThreshold = Number(preferenceStorage.getItem(PRICE_ALERT_THRESHOLD_KEY));
    const savedAcknowledgedActions = readStoredIds(preferenceStorage, "kabutora-acknowledged-actions-v1");
    const savedReadNotifications = readStoredIds(preferenceStorage, "kabutora-read-notifications-v1");
    const savedNotificationHistory = readStoredNotifications(preferenceStorage);
    const savedWatchlist = preferenceStorage.getItem("kabutora-watchlist-v1");

    const cloudWatchlist = seed.watchlist;
    const cloudPreferences = seed.preferences;

    if (cloudWatchlist && Array.isArray(cloudWatchlist) && cloudWatchlist.length > 0) {
      setWatchlist(cloudWatchlist);
      preferenceStorage.setItem("kabutora-watchlist-v1", JSON.stringify(cloudWatchlist));
    } else if (savedWatchlist) {
      try {
        const parsed = JSON.parse(savedWatchlist) as SearchSecurity[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setWatchlist(parsed);
          void onWatchlistChange?.(parsed);
        }
      } catch {
        preferenceStorage.removeItem("kabutora-watchlist-v1");
      }
    }
    preferenceStorage.removeItem("kabutora-transactions");
    preferenceStorage.removeItem("kabutora-accounts-v1");
    preferenceStorage.removeItem("kabutora-custom-securities-v1");

    const pTheme = cloudPreferences?.theme ?? savedTheme;
    if (pTheme === "dark") setDark(true);
    else if (pTheme === "light") setDark(false);

    const pAccent = cloudPreferences?.accentTheme ?? (savedAccent && ["graphite", "blue", "forest", "plum"].includes(savedAccent) ? savedAccent : "graphite");
    setAccentTheme(pAccent);

    const pAutoRefresh = cloudPreferences?.autoRefresh ?? (savedAutoRefresh !== "false");
    setAutoRefresh(pAutoRefresh);

    const pUpdateFreq = cloudPreferences?.updateFrequency ?? (savedUpdateFrequency && [10, 15, 30, 60].includes(savedUpdateFrequency) ? savedUpdateFrequency : 15);
    setUpdateFrequency(pUpdateFreq as UpdateFrequency);

    const pPriceAlert = cloudPreferences?.priceAlertThreshold ?? (savedPriceAlertThreshold && (PRICE_ALERT_THRESHOLDS as readonly number[]).includes(savedPriceAlertThreshold) ? savedPriceAlertThreshold : DEFAULT_PRICE_ALERT_PERCENT);
    setPriceAlertThreshold(pPriceAlert);

    const pDisplayCurrency = cloudPreferences?.displayCurrency ?? (savedDisplayCurrency && ["JPY", "USD", "NATIVE"].includes(savedDisplayCurrency) ? savedDisplayCurrency : "JPY");
    setDisplayCurrency(pDisplayCurrency);

    const pSummaryFilter = cloudPreferences?.summaryMarketFilter ?? (savedSummaryMarketFilter && ["ALL", "JP", "US", "FUNDS_INDEXES"].includes(savedSummaryMarketFilter) ? savedSummaryMarketFilter : "ALL");
    setSummaryMarketFilter(pSummaryFilter);

    const pSummaryBroker = cloudPreferences?.summaryBrokerFilter ?? (savedSummaryBrokerFilter || "ALL");
    setSummaryBrokerFilter(pSummaryBroker);

    const pDivFilter = cloudPreferences?.dividendMarketFilter ?? (savedDividendMarketFilter && ["ALL", "JP", "US", "FUNDS_INDEXES"].includes(savedDividendMarketFilter) ? savedDividendMarketFilter : "ALL");
    setDividendMarketFilter(pDivFilter);

    const pDivCurrency = cloudPreferences?.dividendDisplayCurrency ?? (savedDividendDisplayCurrency && ["JPY", "USD", "NATIVE"].includes(savedDividendDisplayCurrency) ? savedDividendDisplayCurrency : (seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY"));
    setDividendDisplayCurrency(pDivCurrency);

    const pDivPeriod = cloudPreferences?.dividendPeriod ?? (savedDividendPeriod || "ALL");
    setDividendPeriod(pDivPeriod);

    const pDivTax = cloudPreferences?.dividendTaxMode ?? (savedDividendTaxMode && (savedDividendTaxMode === "gross" || savedDividendTaxMode === "net") ? savedDividendTaxMode : "gross");
    setDividendTaxMode(pDivTax);

    const pDivTab = cloudPreferences?.dividendActiveTab ?? (savedDividendTab && (savedDividendTab === "securities" || savedDividendTab === "history") ? savedDividendTab : "securities");
    setDividendActiveTab(pDivTab);

    const pRange = cloudPreferences?.summaryRange ?? (savedSummaryRange && (PORTFOLIO_RANGES.includes(savedSummaryRange) || savedSummaryRange === "CUSTOM") ? savedSummaryRange : "ALL");
    setRange(pRange);

    if (cloudPreferences?.summaryCustomRange) {
      setCustomRange(cloudPreferences.summaryCustomRange);
    } else if (savedSummaryCustomRange) {
      try {
        const parsed = JSON.parse(savedSummaryCustomRange) as CustomDateRange;
        if (parsed && typeof parsed.from === "string" && typeof parsed.to === "string") setCustomRange(parsed);
      } catch {}
    }

    const pAmountsVisible = cloudPreferences?.summaryAmountsVisible ?? (savedSummaryAmountsVisible !== "false");
    setSummaryAmountsVisible(pAmountsVisible);

    const pHideScrollbar = cloudPreferences?.hideScrollbar ?? (savedHideScrollbar !== "false");
    setHideScrollbar(pHideScrollbar);

    const pAck = [...new Set([...(savedAcknowledgedActions ?? []), ...(cloudPreferences?.acknowledgedActions ?? [])])];
    setAcknowledgedActionIds(pAck);

    const pRead = [...new Set([...(savedReadNotifications ?? []), ...(cloudPreferences?.readNotifications ?? [])])];
    setReadNotificationIds(pRead);

    const pNotifHistory = cloudPreferences?.notificationHistory ?? savedNotificationHistory;
    setNotificationHistory(pNotifHistory);

    if (!cloudPreferences && (savedTheme || savedDisplayCurrency || savedAccent || savedAutoRefresh)) {
      void onPreferencesChange?.({
        theme: pTheme === "dark" ? "dark" : "light",
        accentTheme: pAccent,
        autoRefresh: pAutoRefresh,
        updateFrequency: pUpdateFreq as UpdateFrequency,
        displayCurrency: pDisplayCurrency,
        summaryMarketFilter: pSummaryFilter,
        summaryBrokerFilter: pSummaryBroker,
        dividendMarketFilter: pDivFilter,
        dividendDisplayCurrency: pDivCurrency,
        dividendPeriod: pDivPeriod,
        dividendTaxMode: pDivTax,
        dividendActiveTab: pDivTab,
        summaryAmountsVisible: pAmountsVisible,
        hideScrollbar: pHideScrollbar,
        summaryRange: pRange,
        priceAlertThreshold: pPriceAlert,
        acknowledgedActions: pAck,
        readNotifications: pRead,
        notificationHistory: pNotifHistory,
        updatedAt: new Date().toISOString(),
      });
    }
    let cancelled = false;
    const hydrateMarketData = async () => {
      let hasUsableCachedMarket = Object.keys(quotesRef.current).length > 0;
      const [cachedMarket, cachedHistory, cachedDistributions] = allowPersistentMarketCache
        ? await Promise.all([
            readMarketCache<MarketCachePayload>(MARKET_CACHE_KEY, LEGACY_MARKET_CACHE_KEYS),
            readMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, LEGACY_HISTORY_CACHE_KEYS),
            readMarketCache<DistributionCachePayload>(DISTRIBUTION_CACHE_KEY),
          ])
        : [null, null, null];
      if (cancelled) return;
      if (cachedMarket) {
        try {
          const oldestUsableTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const cachedQuotes = Object.fromEntries(Object.entries(cachedMarket.quotes ?? {}).filter(([, quote]) => new Date(quote.marketTimestamp).getTime() >= oldestUsableTimestamp));
          const cachedBenchmarks = (cachedMarket.benchmarks ?? []).filter((benchmark) => new Date(benchmark.marketTimestamp).getTime() >= oldestUsableTimestamp);
          const cachedIntraday = cachedMarket.intradaySeries ? unpackIntradayBars(cachedMarket.intradaySeries) : cachedMarket.intraday ?? [];
          const mergedQuotes = mergeQuoteRecords(cachedQuotes, quotesRef.current);
          const mergedBenchmarks = mergeBenchmarks(cachedBenchmarks, benchmarksRef.current);
          const mergedIntraday = mergeIntradayBars(
            cachedIntraday.filter((bar) => new Date(bar.timestamp).getTime() >= oldestUsableTimestamp),
            intradayBarsRef.current,
          );
          setQuotes(mergedQuotes);
          quotesRef.current = mergedQuotes;
          setBenchmarks(mergedBenchmarks);
          benchmarksRef.current = mergedBenchmarks;
          setIntradayBars(mergedIntraday);
          intradayBarsRef.current = mergedIntraday;
          if (Object.keys(mergedQuotes).length) {
            hasUsableCachedMarket = true;
            setQuoteStatus("partial");
          }
        } catch {
          // Ignore a malformed old snapshot; the network path below will rebuild it.
        }
      }
      if (cachedHistory) {
        try {
          const cachedBars = cachedHistory.series ? unpackHistoryBars(cachedHistory.series) : cachedHistory.bars ?? [];
          const inspected = inspectMarketHistory([], cachedBars, mergeActions(seededActions, cachedHistory.corporateActions ?? []));
          const integrityMismatch = Boolean(cachedHistory.checksum && cachedHistory.checksum !== inspected.quality.checksum);
          const savedAt = cachedHistory.savedAt ?? "";
          historyBarsRef.current = inspected.bars;
          setHistoryBars(inspected.bars);
          historyInceptionDatesRef.current = cachedHistory.inceptionDates ?? {};
          setHistoryInceptionDates(cachedHistory.inceptionDates ?? {});
          corporateActionsRef.current = inspected.actions;
          setCorporateActions(inspected.actions);
          setHistoryQuality({ ...inspected.quality, status: integrityMismatch ? "warning" : inspected.quality.status });
          const nextMeta: HistoryCacheMeta = { savedAt, checksum: inspected.quality.checksum, integrityMismatch };
          historyCacheMetaRef.current = nextMeta;
          setHistoryCacheMeta(nextMeta);
          if (inspected.bars.length) setHistoryStatus(integrityMismatch ? "partial" : "ready");
          setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
          void writeMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, {
            schemaVersion: 11,
            derivationVersion: PERFORMANCE_DERIVATION_VERSION,
            savedAt,
            checksum: inspected.quality.checksum,
            series: packHistoryBars(inspected.bars),
            corporateActions: inspected.actions,
            inceptionDates: cachedHistory.inceptionDates ?? {},
          }, LEGACY_HISTORY_CACHE_KEYS);
          if (!cachedDistributions && cachedHistory.distributions?.length) {
            const legacyEvents = mergeDistributionEvents(cachedHistory.distributions);
            setDistributions(legacyEvents);
            setDistributionStatus("partial");
            void writeMarketCache<DistributionCachePayload>(DISTRIBUTION_CACHE_KEY, {
              schemaVersion: 1,
              savedAt,
              distributions: legacyEvents,
              coverage: [],
            });
          }
        } catch {
          // Corrupt legacy snapshots are ignored and replaced by a network fetch.
        }
      }
      if (cachedDistributions) {
        const cachedEvents = mergeDistributionEvents(cachedDistributions.distributions ?? []);
        setDistributions(cachedEvents);
        setDistributionCoverage(cachedDistributions.coverage ?? []);
        setDistributionCacheSavedAt(cachedDistributions.savedAt ?? "");
        setDistributionStatus((cachedDistributions.coverage ?? []).some((item) => item.status === "error" || item.status === "partial") ? "partial" : "ready");
      }
      if (Object.keys(quotesRef.current).length && historyBarsRef.current.length) {
        logQuotesToHistory(Object.values(quotesRef.current));
      }
      setMarketStartupReady(true);
      setHydrated(true);
    };
    void hydrateMarketData();
    return () => { cancelled = true; };
  }, [allowPersistentMarketCache, persistenceMode]);

  useEffect(() => {
    return syncPageVisibilityDataset();
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const updateSessionClock = () => {
      const resolved = resolveMarketClock(
        trustedClockRef.current,
        typeof performance === "undefined" ? Number.NaN : performance.now(),
        Date.now(),
      );
      if (resolved != null) {
        sessionClockRef.current = resolved;
        setSessionClock(resolved);
      }
    };

    const startTimer = () => {
      if (timer != null) window.clearInterval(timer);
      timer = window.setInterval(updateSessionClock, 30_000);
    };

    const stopTimer = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        updateSessionClock();
        startTimer();
      } else {
        stopTimer();
      }
    };

    updateSessionClock();
    if (document.visibilityState === "visible") {
      startTimer();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (persistenceMode === "cloud") {
      setTransactions((current) => {
        if (current === seed.transactions) return current;
        if (current.length === seed.transactions.length && current.every((item, i) => JSON.stringify(item) === JSON.stringify(seed.transactions[i]))) return current;
        return seed.transactions;
      });
      setAccounts((current) => {
        if (current === seed.accounts) return current;
        if (current.length === seed.accounts.length && current.every((item, i) => JSON.stringify(item) === JSON.stringify(seed.accounts[i]))) return current;
        return seed.accounts;
      });
    }
  }, [persistenceMode, seed.accounts, seed.transactions]);

  useEffect(() => {
    if (selectedAccountId === "__custom__" || accounts.some((account) => account.id === selectedAccountId && (!account.archivedAt || editingTransaction?.accountId === account.id))) return;
    setSelectedAccountId(accounts.find((account) => account.broker !== "現金口座" && !account.archivedAt)?.id ?? accounts.find((account) => !account.archivedAt)?.id ?? "");
  }, [accounts, editingTransaction, selectedAccountId]);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    preferenceStorage.setItem("kabutora-theme", dark ? "dark" : "light");
  }, [dark, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.dataset.accent = accentTheme;
    preferenceStorage.setItem("kabutora-accent", accentTheme);
  }, [accentTheme, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem("kabutora-acknowledged-actions-v1", JSON.stringify(acknowledgedActionIds.slice(-1000)));
  }, [acknowledgedActionIds, allowPersistentMarketCache, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem("kabutora-read-notifications-v1", JSON.stringify(readNotificationIds));
  }, [allowPersistentMarketCache, hydrated, readNotificationIds]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem("kabutora-notification-history-v1", JSON.stringify(notificationHistory));
  }, [allowPersistentMarketCache, hydrated, notificationHistory]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem("kabutora-watchlist-v1", JSON.stringify(watchlist));
  }, [allowPersistentMarketCache, hydrated, watchlist]);

  useEffect(() => {
    preferenceStorage.setItem("kabutora-auto-refresh", String(autoRefresh));
  }, [autoRefresh]);

  useEffect(() => {
    preferenceStorage.setItem("kabutora-update-frequency", String(updateFrequency));
  }, [updateFrequency]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(PRICE_ALERT_THRESHOLD_KEY, String(priceAlertThreshold));
  }, [hydrated, priceAlertThreshold]);

  useEffect(() => {
    preferenceStorage.setItem("kabutora-display-currency", displayCurrency);
  }, [displayCurrency]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(SUMMARY_MARKET_FILTER_KEY, summaryMarketFilter);
    preferenceStorage.setItem(LEGACY_MARKET_FILTER_KEY, summaryMarketFilter);
  }, [hydrated, summaryMarketFilter]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(SUMMARY_BROKER_FILTER_KEY, summaryBrokerFilter);
  }, [hydrated, summaryBrokerFilter]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(DIVIDEND_MARKET_FILTER_KEY, dividendMarketFilter);
  }, [dividendMarketFilter, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(DIVIDEND_DISPLAY_CURRENCY_KEY, dividendDisplayCurrency);
  }, [dividendDisplayCurrency, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(DIVIDEND_PERIOD_KEY, dividendPeriod);
  }, [dividendPeriod, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(DIVIDEND_TAX_MODE_KEY, dividendTaxMode);
  }, [dividendTaxMode, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(DIVIDEND_TAB_KEY, dividendActiveTab);
  }, [dividendActiveTab, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(SUMMARY_AMOUNTS_VISIBLE_KEY, String(summaryAmountsVisible));
  }, [hydrated, summaryAmountsVisible]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(HIDE_SCROLLBAR_KEY, String(hideScrollbar));
    document.documentElement.dataset.hideScrollbar = hideScrollbar ? "true" : "false";
  }, [hideScrollbar, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    preferenceStorage.setItem(SUMMARY_RANGE_KEY, range);
  }, [hydrated, range]);

  useEffect(() => {
    if (!hydrated) return;
    if (customRange) {
      preferenceStorage.setItem(SUMMARY_CUSTOM_RANGE_KEY, JSON.stringify(customRange));
    } else {
      preferenceStorage.removeItem(SUMMARY_CUSTOM_RANGE_KEY);
    }
  }, [customRange, hydrated]);



  useEffect(() => {
    if (!allowPersistentMarketCache || !hydrated || !Object.keys(quotes).length) return;
    const timer = window.setTimeout(() => {
      writeCompactQuotesCache(quotes);
      void writeMarketCache<MarketCachePayload>(MARKET_CACHE_KEY, {
        schemaVersion: 7,
        savedAt: new Date().toISOString(),
        quotes,
        benchmarks,
        intradaySeries: packIntradayBars(intradayBars),
      }, LEGACY_MARKET_CACHE_KEYS);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [allowPersistentMarketCache, benchmarks, hydrated, intradayBars, quotes]);

  const allSecurities = useMemo<SearchSecurity[]>(() => {
    const map = new Map<SearchSecurity["id"], SearchSecurity>();
    for (const security of seed.securities as SearchSecurity[]) {
      map.set(security.id, security);
    }
    for (const security of customSecurities) {
      map.set(security.id, security);
    }
    for (const security of watchlist) {
      map.set(security.id, security);
    }
    const catalog = getEmbeddedCatalogSecurities();
    for (const transaction of transactions) {
      if (!transaction.securityId || map.has(transaction.securityId)) continue;
      const canonical = canonicalDomainSecurityId(transaction.securityId);
      const catalogMatch = catalog.find(
        (item) => canonicalDomainSecurityId(item.id) === canonical || item.displaySymbol.toLowerCase() === canonical.replace(/^sec-(?:us-)?/i, "").toLowerCase(),
      );
      if (catalogMatch) {
        map.set(transaction.securityId, {
          id: transaction.securityId,
          displaySymbol: catalogMatch.displaySymbol,
          name: catalogMatch.name,
          assetType: catalogMatch.assetType,
          country: catalogMatch.country,
          exchangeMic: catalogMatch.exchangeMic,
          currency: catalogMatch.currency,
          exchangeLabel: catalogMatch.exchangeLabel,
          providerSymbols: catalogMatch.providerSymbols ?? {},
        });

      } else {
        const requested = normalizeRequestedSecurity(transaction.securityId);
        if (requested) {
          map.set(transaction.securityId, {
            id: transaction.securityId,
            displaySymbol: requested.displaySymbol,
            name: requested.displaySymbol,
            assetType: requested.venueCode === "FUND" || requested.venueCode === "USD_FUND" ? "fund" : requested.venueCode === "INDEX" ? "index" : "stock",
            country: requested.currency === "USD" ? "US" : "JP",
            exchangeMic: requested.exchangeMic,
            currency: requested.currency,
            exchangeLabel: requested.exchangeMic,
            providerSymbols: { yahoo: requested.providerSymbol },
          });
        }
      }

    }
    return [...map.values()];
  }, [customSecurities, seed.securities, transactions, watchlist]);


  const lastSyncedRegistryKeyRef = useRef<string>("");
  useEffect(() => {
    if (!hydrated || persistenceMode !== "cloud" || !allSecurities.length) return;
    const currentKey = [...new Set(allSecurities.map((security) => security.id))].sort().join(",");
    if (currentKey === lastSyncedRegistryKeyRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      lastSyncedRegistryKeyRef.current = currentKey;
      void syncServerMarketRegistry(allSecurities.map((security) => security.id), "merge").catch(() => false);
    }, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [allSecurities, hydrated, persistenceMode]);
  const accountMap = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const activeAccounts = useMemo(() => accounts.filter((account) => !account.archivedAt), [accounts]);
  const selectableAccounts = useMemo(() => {
    const editingAccount = editingTransaction ? accountMap.get(editingTransaction.accountId) : undefined;
    return editingAccount?.archivedAt && !activeAccounts.some((account) => account.id === editingAccount.id) ? [...activeAccounts, editingAccount] : activeAccounts;
  }, [accountMap, activeAccounts, editingTransaction]);
  const calculationTransactions = useMemo(() => transactions.map((transaction) => ({
    ...transaction,
    costBasisGroup: costBasisGroupForAccount(accountMap.get(transaction.accountId), transaction.accountId),
  })), [accountMap, transactions]);
  const transactionRevision = useMemo(() => transactions.map((transaction) => [
    transaction.id,
    transaction.version,
    transaction.updatedAt,
    transaction.accountId,
    transaction.securityId,
    transaction.tradeDate,
    transaction.type,
    transaction.quantity,
    transaction.pricePerShare,
    transaction.grossAmount,
  ].join(":" )).sort().join("|"), [transactions]);
  const transactionRevisionRef = useRef("");
  const todayKey = marketDateKey(new Date(sessionClock ?? Date.now()).toISOString(), "XTKS");
  const applicableCorporateActions = useMemo(() => corporateActions.filter((action) => action.effectiveDate.slice(0, 10) <= todayKey), [corporateActions, todayKey]);

  const positionSeed = useMemo(
    () => calculateAverageCostPortfolio(calculationTransactions, allSecurities, applicableCorporateActions),
    [allSecurities, applicableCorporateActions, calculationTransactions],
  );
  const detailSecurityScope = view === "security" ? detailSecurityId : "";
  const hasForeignSecurities = useMemo(() => (
    positionSeed.holdings.some((holding) => {
      const s = allSecurities.find((sec) => sec.id === holding.securityId);
      return s?.currency === "USD" || s?.country === "US" || isUsSecurity(s, holding.securityId);
    })
    || watchlist.some((item) => item.currency === "USD" || item.country === "US" || isUsSecurity(item, item.id))
    || transactions.some((t) => t.tradeCurrency !== "JPY")
  ), [allSecurities, positionSeed.holdings, transactions, watchlist]);

  const quoteSecurityIds = useMemo(() => [...new Set([
    ...positionSeed.holdings.map((holding) => holding.securityId),
    ...watchlist.map((item) => item.id),
    ...(detailSecurityScope ? [detailSecurityScope] : []),
    FX_SECURITY_ID,
  ])].sort().join(","), [detailSecurityScope, positionSeed.holdings, watchlist]);
  const usIntradayRequestsRef = useRef(new Map<string, Promise<Awaited<ReturnType<typeof loadServerUsIntraday>>>>());
  const refreshServerUsIntraday = useCallback(async (recover = false) => {
    if (!hydrated || document.visibilityState !== "visible") return;
    const usIds = splitSecurityIds(quoteSecurityIds, Number.MAX_SAFE_INTEGER)
      .flat()
      .map(canonicalDomainSecurityId)
      .filter((securityId) => /^sec-us-/u.test(securityId));
    const batches = splitSecurityIds([...new Set(usIds)].join(","), 20);
    if (!batches.length) return;
    const responses = await Promise.allSettled(batches.map((batch) => {
      const key = `${recover ? "recover" : "read"}:${batch.join(",")}`;
      const existing = usIntradayRequestsRef.current.get(key);
      if (existing) return existing;
      const request = loadServerUsIntraday(batch, { recover }).finally(() => {
        usIntradayRequestsRef.current.delete(key);
      });
      usIntradayRequestsRef.current.set(key, request);
      return request;
    }));
    const incoming: IntradayBar[] = [];
    for (const response of responses) {
      if (response.status !== "fulfilled" || !response.value) continue;
      acceptTrustedServerTime(response.value.generatedAt);
      for (const bar of response.value.bars) {
        incoming.push(bar);
        for (const variant of domainSecurityIdVariants(bar.securityId)) {
          if (variant !== bar.securityId) incoming.push({ ...bar, securityId: variant });
        }
      }
    }
    if (incoming.length) {
      const merged = mergeIntradayBars(intradayBarsRef.current, incoming);
      intradayBarsRef.current = merged;
      setIntradayBars(merged);
    }
  }, [acceptTrustedServerTime, hydrated, quoteSecurityIds]);

  useEffect(() => {
    void refreshServerUsIntraday(true);
  }, [refreshServerUsIntraday]);

  const ptsCursorRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!hydrated || persistenceMode !== "cloud") return;
    const japaneseIds = splitSecurityIds(quoteSecurityIds, Number.MAX_SAFE_INTEGER)
      .flat()
      .map(canonicalDomainSecurityId)
      .filter((securityId) => /^sec-(?:\d{4}|\d{3}[a-z])$/iu.test(securityId));
    const batches = splitSecurityIds([...new Set(japaneseIds)].join(","), 20);
    if (!batches.length) return;
    let cancelled = false;
    let timer: number | null = null;
    const refreshPts = async () => {
      if (document.visibilityState !== "visible") return;
      const responses = await Promise.allSettled(batches.map(async (batch) => {
        const key = batch.join(",");
        const result = await loadServerPtsIntraday(batch, ptsCursorRef.current.get(key));
        if (result.nextCursor) ptsCursorRef.current.set(key, result.nextCursor);
        return result;
      }));
      if (cancelled) return;
      const incoming: IntradayBar[] = [];
      for (const response of responses) {
        if (response.status !== "fulfilled") continue;
        for (const bar of response.value.bars) {
          incoming.push(bar);
          for (const variant of domainSecurityIdVariants(bar.securityId)) {
            if (variant !== bar.securityId) incoming.push({ ...bar, securityId: variant });
          }
        }
      }
      if (incoming.length) {
        const merged = mergeIntradayBars(intradayBarsRef.current, incoming);
        intradayBarsRef.current = merged;
        setIntradayBars(merged);
      }
    };
    void refreshPts();
    timer = window.setInterval(() => { void refreshPts(); }, 60_000);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [hydrated, persistenceMode, quoteSecurityIds]);
  const hasForeignTransactions = useMemo(() => transactions.some((transaction) => transaction.tradeCurrency !== "JPY"), [transactions]);
  const needsFxHistory = useMemo(() => displayCurrency === "USD" ? transactions.some((t) => t.tradeCurrency !== "USD") : (hasForeignTransactions || hasForeignSecurities), [displayCurrency, hasForeignSecurities, hasForeignTransactions, transactions]);
  const historySecurityIds = useMemo(() => [...new Set([
    ...transactions.map((transaction) => transaction.securityId).filter((value): value is string => Boolean(value)),
    ...watchlist.map((item) => item.id),
    ...(needsFxHistory ? [FX_SECURITY_ID] : []),
    ...(detailSecurityScope ? [detailSecurityScope] : []),
  ])].sort().join(","), [detailSecurityScope, needsFxHistory, transactions, watchlist]);
  const distributionSecurityIds = useMemo(() => [...new Set(
    transactions.flatMap((transaction) => {
      if (!transaction.securityId) return [];
      const securityId = canonicalDomainSecurityId(transaction.securityId);
      return securityId.startsWith("sec-fx-") ? [] : [securityId];
    }),
  )].sort().join(","), [transactions]);
  const historyCoverageRequired = useMemo(() => {
    const earliestBySecurity = new Map<string, string>();
    for (const transaction of transactions) {
      if (!transaction.securityId) continue;
      const date = transaction.tradeDate.slice(0, 10);
      const current = earliestBySecurity.get(transaction.securityId);
      if (!current || date < current) earliestBySecurity.set(transaction.securityId, date);
    }
    const oneYearAgo = new Date();
    oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
    const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);
    for (const item of watchlist) {
      if (!earliestBySecurity.has(item.id)) {
        earliestBySecurity.set(item.id, oneYearAgoStr);
      }
    }
    if (detailSecurityScope && !earliestBySecurity.has(detailSecurityScope)) {
      const fiveYearsAgo = new Date();
      fiveYearsAgo.setUTCFullYear(fiveYearsAgo.getUTCFullYear() - 5);
      earliestBySecurity.set(detailSecurityScope, fiveYearsAgo.toISOString().slice(0, 10));
    }
    if (needsFxHistory) {
      const allDates = [...earliestBySecurity.values()].sort();
      const fiveYearsAgo = new Date();
      fiveYearsAgo.setUTCFullYear(fiveYearsAgo.getUTCFullYear() - 5);
      const fiveYearsAgoStr = fiveYearsAgo.toISOString().slice(0, 10);
      const earliestNeeded = allDates[0] ?? todayKey;
      earliestBySecurity.set(FX_SECURITY_ID, earliestNeeded);
    }
    return earliestBySecurity;
  }, [detailSecurityScope, needsFxHistory, transactions, watchlist]);
  const needsHistoryBackfill = useCallback((bars: MarketBar[]) => missingHistoryRequirements(bars, historyCoverageRequired, historyInceptionDates, todayKey).length > 0, [historyCoverageRequired, historyInceptionDates, todayKey]);

  const loadQuotes = useCallback(async (force = false, mode: "full" | "incremental" | "scheduled" = "incremental") => {
    if (!quoteSecurityIds) return;
    const allIds = splitSecurityIds(quoteSecurityIds, Number.MAX_SAFE_INTEGER).flat();
    const refreshNow = sessionClockRef.current ?? Date.now();
    const transitionIds = new Set(quoteSessionTransitionTargets(allIds, quotesRef.current, refreshNow));
    const hasIntraday = (id: string) => {
      const requested = normalizeRequestedSecurity(id);
      const variants = new Set(domainSecurityIdVariants(id));
      const expectedSession = marketSessionDateKey(
        new Date(refreshNow).toISOString(),
        requested?.exchangeMic,
        undefined,
        requested?.currency,
        requested?.currency === "USD" ? "US" : "JP",
      );
      return new Set(intradayBarsRef.current
        .filter((bar) => (bar.securityId === id || variants.has(bar.securityId)) && marketSessionDateKey(
          bar.timestamp,
          requested?.exchangeMic,
          undefined,
          requested?.currency,
          requested?.currency === "USD" ? "US" : "JP",
        ) === expectedSession)
        .map((bar) => bar.timestamp)).size >= 2;
    };
    const targetIds = quoteRefreshTargets(allIds, quotesRef.current, { force, full: mode === "full", now: refreshNow, hasIntraday });
    if (!targetIds.length) return;
    if (!force && mode !== "full" && Date.now() - lastQuoteRequestAtRef.current < 3_000) {
      return;
    }
    if (quoteRequestInFlight.current) {
      quoteReloadPending.current = true;
      return;
    }
    quoteRequestInFlight.current = true;
    lastQuoteRequestAtRef.current = Date.now();
    const batches = splitSecurityIds(targetIds.join(","));
    setApiUsage((current) => ({ ...current, quoteRequests: current.quoteRequests + batches.length, lastQuoteRequest: new Date().toISOString() }));
    setQuoteStatus((current) => current === "ready" || current === "partial" ? current : "loading");
    try {
      const headers = { ...await getMarketAuthHeaders(), "Content-Type": "application/json" };
      const responses = await pooledClientMap(batches, 3, async (securityIds) => {
        try {
          const response = await fetchMarketResponse("/api/market/quotes", {
            method: "POST",
            cache: "no-store",
            headers,
            body: JSON.stringify({
              securityIds: securityIds.join(","),
              refreshSecurityIds: securityIds.filter((securityId) => transitionIds.has(securityId)).join(","),
              includeIntraday: true,
              intradayRange: "1d",
              refresh: force,
            }),
            signal: timeoutSignal(45_000),
          });
          const payload = await readMarketApiResponse<QuoteResponse>(response, "価格データの応答を確認できませんでした");
          return { ok: response.ok, payload };
        } catch (error) {
          const message = stableMarketErrorMessage(error, "価格バッチを取得できませんでした");
          return {
            ok: false,
            payload: {
              quotes: [],
              intraday: [],
              failures: securityIds.map((securityId) => ({ securityId, symbol: securityId, message })),
              coverage: { requested: securityIds.length, returned: 0, fresh: 0, stale: 0, suspect: 0 },
            } satisfies QuoteResponse,
          };
        }
      });
      const payload = {
        quotes: responses.flatMap((item) => item.payload.quotes ?? []),
        intraday: responses.flatMap((item) => item.payload.intraday ?? []),
        failures: responses.flatMap((item) => item.payload.failures ?? []),
      };
      acceptTrustedServerTime(responses.map((item) => item.payload.generatedAt).filter((value): value is string => Boolean(value)).sort().at(-1));
      const latestServerSessions = latestMarketSessions(responses);
      if (latestServerSessions) setServerMarketSessions(latestServerSessions);
      if (!payload.quotes.length && responses.some((item) => !item.ok)) throw new Error(payload.failures[0]?.message ?? "価格を取得できませんでした");
      const incomingQuotes: Record<string, RemoteQuote> = {};
      for (const quote of payload.quotes) {
        incomingQuotes[quote.securityId] = quote;
        for (const variant of domainSecurityIdVariants(quote.securityId)) {
          if (!incomingQuotes[variant]) {
            incomingQuotes[variant] = { ...quote, securityId: variant };
          }
        }
      }
      const nextQuotes = mergeQuoteRecords(quotesRef.current, incomingQuotes);
      quotesRef.current = nextQuotes;
      setQuotes(nextQuotes);
      const returnedIds = new Set(payload.quotes.map((quote) => quote.securityId));
      const incomingBars: IntradayBar[] = [];
      for (const bar of payload.intraday ?? []) {
        incomingBars.push(bar);
        for (const variant of domainSecurityIdVariants(bar.securityId)) {
          if (variant !== bar.securityId) {
            incomingBars.push({ ...bar, securityId: variant });
          }
        }
      }
      const nextBars = mergeIntradayBars(intradayBarsRef.current, incomingBars);
      intradayBarsRef.current = nextBars;
      setIntradayBars(nextBars);
      logQuotesToHistory(payload.quotes);
      const suspect = payload.quotes.filter((quote) => quote.validationStatus === "suspect").length;
      const requestedIds = batches.flat();
      const cachedFallbackIds = requestedIds.filter((securityId) => !returnedIds.has(securityId) && Boolean(quotesRef.current[securityId]));
      const missingIds = requestedIds.filter((securityId) => !returnedIds.has(securityId) && !quotesRef.current[securityId]);
      const cachedFallbackSet = new Set(cachedFallbackIds);
      const failedIds = [...new Set([...payload.failures.map((failure) => failure.securityId).filter((securityId) => !cachedFallbackSet.has(securityId)), ...missingIds])];
      setQuoteHealth({ requested: requestedIds.length, returned: returnedIds.size, failedIds, fallbackIds: cachedFallbackIds, updatedAt: new Date().toISOString() });
      setQuoteStatus(failedIds.length || cachedFallbackIds.length || suspect ? "partial" : "ready");
      setMarketError(failedIds.length ? `${failedIds.length}銘柄の現在値を取得できませんでした` : suspect ? `${suspect}銘柄で大きな変動を検出` : "");
    } catch (error) {
      const requestedIds = batches.flat();
      const fallbackIds = requestedIds.filter((securityId) => Boolean(quotesRef.current[securityId]));
      setQuoteHealth({ requested: requestedIds.length, returned: 0, failedIds: requestedIds.filter((securityId) => !fallbackIds.includes(securityId)), fallbackIds, updatedAt: new Date().toISOString() });
      setQuoteStatus((current) => current === "ready" || current === "partial" ? "partial" : "error");
      setMarketError(stableMarketErrorMessage(error, "市場価格を取得できませんでした"));
    } finally {
      quoteRequestInFlight.current = false;
      if (quoteReloadPending.current) {
        quoteReloadPending.current = false;
        const allIds = splitSecurityIds(quoteSecurityIds, Number.MAX_SAFE_INTEGER).flat();
        const refreshNow = sessionClockRef.current ?? Date.now();
        const remainingTargets = quoteRefreshTargets(allIds, quotesRef.current, {
          now: refreshNow,
          hasIntraday,
        });
        if (remainingTargets.length > 0) {
          if (quoteReloadTimerRef.current !== null) {
            window.clearTimeout(quoteReloadTimerRef.current);
          }
          quoteReloadTimerRef.current = window.setTimeout(() => {
            quoteReloadTimerRef.current = null;
            void loadQuotes(false, "incremental");
          }, 3_000);
        }
      }
    }
  }, [acceptTrustedServerTime, logQuotesToHistory, quoteSecurityIds]);

  const loadBenchmarks = useCallback(async (force = false) => {
    const cached = benchmarksRef.current;
    const cacheFresh = cached.length > 0 && cached.every((benchmark) => {
      const fetchedAt = new Date(benchmark.fetchedAt ?? "").getTime();
      const maxAge = cached.length >= 5 ? 9 * 60 * 1000 : 3 * 60 * 1000;
      return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < maxAge;
    });
    if (!force && cacheFresh) {
      setBenchmarkStatus("ready");
      return;
    }
    if (benchmarkRequestInFlight.current) return;
    benchmarkRequestInFlight.current = true;
    setApiUsage((current) => ({ ...current, benchmarkRequests: current.benchmarkRequests + 1, lastBenchmarkRequest: new Date().toISOString() }));
    setBenchmarkStatus((current) => current === "ready" || current === "partial" ? current : "loading");
    try {
      const response = await fetchMarketResponse(`/api/market/benchmarks${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
        headers: await getMarketAuthHeaders(),
        signal: timeoutSignal(45_000),
      });
      const payload = await readMarketApiResponse<BenchmarkResponse>(response, "指標データの応答を確認できませんでした");
      acceptTrustedServerTime(payload.generatedAt);
      if (payload.marketSessions?.length) setServerMarketSessions(payload.marketSessions);
      if (!response.ok && !payload.benchmarks?.length) throw new Error("指標を取得できませんでした");
      setBenchmarks((current) => [...new Map([...current, ...(payload.benchmarks ?? [])].map((benchmark) => [benchmark.id, benchmark])).values()]);
      setBenchmarkStatus(payload.failures.length ? "partial" : "ready");
    } catch {
      setBenchmarkStatus((current) => current === "ready" || current === "partial" ? "partial" : "error");
    } finally {
      benchmarkRequestInFlight.current = false;
    }
  }, [acceptTrustedServerTime]);

  const loadHistory = useCallback(async (force = false) => {
    if (!historySecurityIds) return;
    if (historyRequestInFlight.current) {
      historyReloadPending.current = true;
      return;
    }
    historyRequestInFlight.current = true;
    // History payloads contain years of bars, unlike the small quote batches.
    const plan = buildHistoryFetchPlan(historySecurityIds, historyCoverageRequired, force ? [] : historyBars, 2, historyInceptionDates, todayKey);
    setApiUsage((current) => ({ ...current, historyRequests: current.historyRequests + plan.length, lastHistoryRequest: new Date().toISOString() }));
    setHistoryStatus("loading");
    setHistoryError("");
    try {
      const headers = { ...await getMarketAuthHeaders(), "Content-Type": "application/json" };
      const responses = await pooledClientMap(plan, 2, async (batch) => {
        try {
          const response = await fetchMarketResponse("/api/market/history", {
            method: "POST",
            cache: "no-store",
            headers,
            body: JSON.stringify({ securityIds: batch.securityIds.join(","), from: batch.from, refresh: force || batch.forceRefresh === true }),
            signal: timeoutSignal(60_000),
          });
          const payload = await readMarketApiResponse<HistoryResponse>(response, "履歴データの応答を確認できませんでした");
          return { ok: response.ok, payload };
        } catch (error) {
          const message = stableMarketErrorMessage(error, "履歴バッチを取得できませんでした");
          return {
            ok: false,
            payload: {
              bars: [],
              corporateActions: [],
              failures: batch.securityIds.map((securityId) => ({ securityId, symbol: securityId, message })),
              coverage: { requested: batch.securityIds.length, returned: 0 },
            } satisfies HistoryResponse,
          };
        }
      });
      const incomingBars = responses.flatMap((item) => item.payload.bars ?? []);
      acceptTrustedServerTime(responses.map((item) => item.payload.generatedAt).filter((value): value is string => Boolean(value)).sort().at(-1));
      const latestServerSessions = latestMarketSessions(responses);
      if (latestServerSessions) setServerMarketSessions(latestServerSessions);
      const incomingActions = responses.flatMap((item) => item.payload.corporateActions ?? []);
      const incomingInceptionDates = Object.assign({}, ...responses.map((item) => item.payload.inceptionDates ?? {})) as Record<string, string>;
      const nextInceptionDates = { ...historyInceptionDates, ...incomingInceptionDates };
      const responseFailures = responses.flatMap((item) => item.payload.failures ?? []);
      if (!incomingBars.length && !historyBars.length && responses.some((item) => !item.ok)) throw new Error(responseFailures[0]?.message ?? "履歴を取得できませんでした");
      const inspected = inspectMarketHistory(historyBars, incomingBars, mergeActions(seededActions, corporateActions, incomingActions));
      const requestedIds = plan.flatMap((batch) => batch.securityIds);
      const failedResponseIds = new Set(responseFailures.map((failure) => failure.securityId));
      const missingRequiredIds = missingHistoryRequirements(inspected.bars, historyCoverageRequired, nextInceptionDates);
      const cachedFallbackIds = requestedIds.filter((securityId) => failedResponseIds.has(securityId) && historyCoverage(inspected.bars).has(securityId));
      const failedIds = [...new Set([...missingRequiredIds, ...[...failedResponseIds].filter((securityId) => !cachedFallbackIds.includes(securityId))])];
      const savedAt = new Date().toISOString();
      historyBarsRef.current = inspected.bars;
      setHistoryBars(inspected.bars);
      historyInceptionDatesRef.current = nextInceptionDates;
      setHistoryInceptionDates(nextInceptionDates);
      corporateActionsRef.current = inspected.actions;
      setCorporateActions(inspected.actions);
      setHistoryQuality(inspected.quality);
      const nextMeta: HistoryCacheMeta = { savedAt, checksum: inspected.quality.checksum };
      historyCacheMetaRef.current = nextMeta;
      setHistoryCacheMeta(nextMeta);
      setHistoryHealth({ requested: requestedIds.length, returned: requestedIds.length - failedResponseIds.size, failedIds, fallbackIds: cachedFallbackIds, updatedAt: savedAt });
      setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
      if (allowPersistentMarketCache) {
        void writeMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, {
          schemaVersion: 11,
          derivationVersion: PERFORMANCE_DERIVATION_VERSION,
          savedAt,
          checksum: inspected.quality.checksum,
          series: packHistoryBars(inspected.bars),
          corporateActions: inspected.actions,
          inceptionDates: nextInceptionDates,
        }, LEGACY_HISTORY_CACHE_KEYS);
      }
      const partial = failedIds.length || cachedFallbackIds.length || inspected.quality.status === "warning";
      setHistoryStatus(partial ? "partial" : "ready");
      const failedLabels = failedIds.map((securityId) => securityId === FX_SECURITY_ID ? "USD/JPY" : allSecurities.find((security) => security.id === securityId)?.displaySymbol ?? securityId).slice(0, 4);
      setHistoryError(failedIds.length ? `履歴不足: ${failedLabels.join("、")}${failedIds.length > failedLabels.length ? `ほか${failedIds.length - failedLabels.length}銘柄` : ""}` : inspected.quality.status === "warning" ? "履歴データの整合性警告を検出しました" : "");
    } catch (error) {
      const requestedIds = plan.flatMap((batch) => batch.securityIds);
      const cachedIds = new Set(historyCoverage(historyBars).keys());
      const fallbackIds = requestedIds.filter((securityId) => cachedIds.has(securityId));
      setHistoryHealth({ requested: requestedIds.length, returned: 0, failedIds: requestedIds.filter((securityId) => !fallbackIds.includes(securityId)), fallbackIds, updatedAt: new Date().toISOString() });
      setHistoryStatus((current) => historyBars.length || current === "partial" ? "partial" : "error");
      setHistoryError(stableMarketErrorMessage(error, "履歴を取得できませんでした"));
    } finally {
      historyRequestInFlight.current = false;
      if (historyReloadPending.current) {
        historyReloadPending.current = false;
        setHistoryRequested(false);
      }
    }
  }, [acceptTrustedServerTime, allowPersistentMarketCache, allSecurities, corporateActions, historyBars, historyCoverageRequired, historyInceptionDates, historySecurityIds, todayKey]);

  const loadDistributions = useCallback(async (force = false) => {
    const requestedIds = splitSecurityIds(distributionSecurityIds, Number.MAX_SAFE_INTEGER).flat();
    if (!requestedIds.length) {
      setDistributionStatus("ready");
      return;
    }
    if (distributionRequestInFlight.current) {
      distributionReloadPending.current = true;
      return;
    }
    distributionRequestInFlight.current = true;
    setDistributionStatus("loading");
    setDistributionError("");
    try {
      const headers = { ...await getMarketAuthHeaders(), "Content-Type": "application/json" };
      const batches = splitSecurityIds(requestedIds.join(","), MARKET_REQUEST_BATCH_SIZE);
      const responses = await pooledClientMap(batches, 2, async (securityIds) => {
        try {
          const response = await fetchMarketResponse("/api/market/distributions", {
            method: "POST",
            cache: "no-store",
            headers,
            body: JSON.stringify({ securityIds: securityIds.join(","), refresh: force }),
            signal: timeoutSignal(60_000),
          });
          const payload = await readMarketApiResponse<DistributionResponse>(response, "配当データの応答を確認できませんでした");
          return { ok: response.ok, payload };
        } catch (error) {
          const message = stableMarketErrorMessage(error, "配当バッチを取得できませんでした");
          return {
            ok: false,
            payload: {
              generatedAt: new Date().toISOString(),
              distributions: [],
              corporateActions: [],
              coverage: [],
              failures: securityIds.map((securityId) => ({ securityId, symbol: securityId, message })),
            } satisfies DistributionResponse,
          };
        }
      });
      const incomingEvents = responses.flatMap((item) => item.payload.distributions ?? []);
      const incomingCoverage = responses.flatMap((item) => item.payload.coverage ?? []);
      const incomingActions = responses.flatMap((item) => item.payload.corporateActions ?? []);
      const failures = responses.flatMap((item) => item.payload.failures ?? []);
      const nextEvents = mergeDistributionEvents(distributions, incomingEvents);
      const nextCoverage = [...new Map([...distributionCoverage, ...incomingCoverage].map((item) => [canonicalDomainSecurityId(item.securityId), { ...item, securityId: canonicalDomainSecurityId(item.securityId) }])).values()];
      const coveredIds = new Set(nextCoverage.filter((item) => item.status === "ready" || item.status === "no_events").map((item) => item.securityId));
      const missingIds = requestedIds.filter((securityId) => !coveredIds.has(canonicalDomainSecurityId(securityId)));
      const savedAt = new Date().toISOString();
      setDistributions(nextEvents);
      setDistributionCoverage(nextCoverage);
      setCorporateActions((current) => mergeActions(seededActions, current, incomingActions));
      setDistributionCacheSavedAt(savedAt);
      const partial = failures.length > 0 || missingIds.length > 0 || nextCoverage.some((item) => item.status === "partial" || item.status === "error");
      setDistributionStatus(partial ? "partial" : "ready");
      setDistributionError(failures.length ? `配当取得失敗: ${failures.slice(0, 3).map((failure) => failure.symbol || failure.securityId).join("、")}` : missingIds.length ? `${missingIds.length}銘柄の配当カバレッジを確認中` : "");
      if (allowPersistentMarketCache) void writeMarketCache<DistributionCachePayload>(DISTRIBUTION_CACHE_KEY, {
        schemaVersion: 1,
        savedAt,
        distributions: nextEvents,
        coverage: nextCoverage,
      });
    } catch (error) {
      setDistributionStatus(distributions.length || distributionCoverage.length ? "partial" : "error");
      setDistributionError(stableMarketErrorMessage(error, "配当データを取得できませんでした"));
    } finally {
      distributionRequestInFlight.current = false;
      if (distributionReloadPending.current) {
        distributionReloadPending.current = false;
        setDistributionCacheSavedAt("");
      }
    }
  }, [allowPersistentMarketCache, distributionCoverage, distributionSecurityIds, distributions]);

  useEffect(() => { quotesRef.current = quotes; }, [quotes]);
  useEffect(() => { benchmarksRef.current = benchmarks; }, [benchmarks]);
  useEffect(() => { intradayBarsRef.current = intradayBars; }, [intradayBars]);
  useEffect(() => { historyBarsRef.current = historyBars; }, [historyBars]);
  useEffect(() => { historyInceptionDatesRef.current = historyInceptionDates; }, [historyInceptionDates]);
  useEffect(() => { corporateActionsRef.current = corporateActions; }, [corporateActions]);
  useEffect(() => { historyCacheMetaRef.current = historyCacheMeta; }, [historyCacheMeta]);
  useEffect(() => () => {
    if (quoteReloadTimerRef.current !== null) window.clearTimeout(quoteReloadTimerRef.current);
  }, []);
  useEffect(() => {
    if (!hydrated || marketStartupRunRef.current) return;
    marketStartupRunRef.current = true;
    const hasQuotes = Object.keys(quotesRef.current).length > 0;
    const snapshotAge = initialMarketSnapshot?.savedAt ? Date.now() - Date.parse(initialMarketSnapshot.savedAt) : Number.POSITIVE_INFINITY;
    const snapshotFresh = Number.isFinite(snapshotAge) && snapshotAge < 3 * 60 * 1000;
    if (snapshotFresh && hasQuotes) {
      setMarketStartupReady(true);
      return;
    }
    const mode = hasQuotes ? "incremental" : "full";
    quoteEffectKeyRef.current = `${quoteSecurityIds}|${quoteRefreshToken}`;
    void Promise.allSettled([
      loadQuotes(false, mode),
      loadBenchmarks(),
    ]).then(() => setMarketStartupReady(true));
  }, [hydrated, initialMarketSnapshot, loadBenchmarks, loadQuotes, persistenceMode, quoteRefreshToken, quoteSecurityIds]);

  useEffect(() => {
    if (!hydrated) return;
    const currentRange = range;
    const previousRange = prevRangeViewRef.current;
    prevRangeViewRef.current = currentRange;
    if (!previousRange) return;
    if (previousRange !== currentRange && (currentRange === "1D" || currentRange === "1W")) {
      void loadQuotes(false, "incremental");
    }
  }, [hydrated, loadQuotes, range]);

  useEffect(() => {
    if (!hydrated || !marketStartupRunRef.current) return;
    const key = `${quoteSecurityIds}|${quoteRefreshToken}`;
    if (quoteEffectKeyRef.current === key) return;
    quoteEffectKeyRef.current = key;
    void loadQuotes(false, "incremental");
  }, [hydrated, loadQuotes, quoteRefreshToken, quoteSecurityIds]);

  useEffect(() => {
    if (!hydrated) return;
    if (transactionRevisionRef.current && transactionRevisionRef.current !== transactionRevision) {
      setHistoryRequested(false);
      setQuoteRefreshToken((current) => current + 1);
    }
    transactionRevisionRef.current = transactionRevision;
  }, [hydrated, transactionRevision]);

  useEffect(() => {
    if (!hydrated || !["overview", "performance", "security", "dividends", "notifications"].includes(view) || historyRequested) return;
    setHistoryRequested(true);
    const cacheAge = historyCacheMeta?.savedAt ? Date.now() - new Date(historyCacheMeta.savedAt).getTime() : Number.POSITIVE_INFINITY;
    const needsRefresh = !historyBars.length;
    if (historyBars.length && cacheAge < HISTORY_NETWORK_REVALIDATE_MS && !historyCacheMeta?.integrityMismatch && !needsHistoryBackfill(historyBars)) {
      setHistoryStatus(historyQuality?.status === "warning" ? "partial" : "ready");
      setApiUsage((current) => ({ ...current, historyCacheHits: current.historyCacheHits + 1 }));
      return;
    }
    void loadHistory(needsRefresh);
  }, [historyBars, historyCacheMeta, historyQuality, historyRequested, hydrated, loadHistory, needsHistoryBackfill, view]);

  useEffect(() => {
    if (!hydrated || !distributionSecurityIds) return;
    if (view !== "dividends" && view !== "security") return;
    const requestedIds = splitSecurityIds(distributionSecurityIds, Number.MAX_SAFE_INTEGER).flat().map(canonicalDomainSecurityId);
    const coverageMap = new Map(distributionCoverage.map((item) => [canonicalDomainSecurityId(item.securityId), item]));
    const coverageIncomplete = requestedIds.some((securityId) => {
      const item = coverageMap.get(securityId);
      return !item || item.status === "partial" || item.status === "error";
    });
    const cacheAge = distributionCacheSavedAt ? Date.now() - new Date(distributionCacheSavedAt).getTime() : Number.POSITIVE_INFINITY;
    if (!coverageIncomplete && cacheAge < DISTRIBUTION_NETWORK_REVALIDATE_MS) {
      setDistributionStatus("ready");
      return;
    }
    if (distributionAttemptKey.current === distributionSecurityIds) return;
    distributionAttemptKey.current = distributionSecurityIds;
    void loadDistributions(false);
  }, [distributionCacheSavedAt, distributionCoverage, distributionSecurityIds, hydrated, loadDistributions, view]);

  const requirementSignature = useMemo(() => `${[...historyCoverageRequired].map(([securityId, date]) => `${securityId}:${date}`).sort().join("|")}|${todayKey}`, [historyCoverageRequired, todayKey]);
  useEffect(() => {
    if (!hydrated) return;
    if (historyRequirementKey.current && historyRequirementKey.current !== requirementSignature && needsHistoryBackfill(historyBars)) setHistoryRequested(false);
    historyRequirementKey.current = requirementSignature;
  }, [historyBars, hydrated, needsHistoryBackfill, requirementSignature]);

  useEffect(() => {
    if (!hydrated || !historyBars.length) return;
    let timer: number | null = null;

    const inspectLocalCache = () => {
      const inspected = inspectMarketHistory([], historyBars, corporateActions);
      setHistoryQuality(inspected.quality);
      setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
      if (inspected.quality.checksum !== historyCacheMeta?.checksum) {
        setHistoryBars(inspected.bars);
        setCorporateActions(inspected.actions);
        setHistoryCacheMeta((current) => current ? { ...current, checksum: inspected.quality.checksum, integrityMismatch: true } : current);
        setHistoryStatus("partial");
        setHistoryError("履歴キャッシュの整合性不一致を検出し、再取得しています");
        setHistoryRequested(false);
      }
      const cacheAge = historyCacheMeta?.savedAt ? Date.now() - new Date(historyCacheMeta.savedAt).getTime() : Number.POSITIVE_INFINITY;
      if (document.visibilityState === "visible" && cacheAge >= HISTORY_NETWORK_REVALIDATE_MS) setHistoryRequested(false);
    };

    const startTimer = () => {
      if (timer != null) window.clearInterval(timer);
      timer = window.setInterval(inspectLocalCache, HISTORY_INTEGRITY_CHECK_MS);
    };

    const stopTimer = () => {
      if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        inspectLocalCache();
        startTimer();
      } else {
        stopTimer();
      }
    };

    if (document.visibilityState === "visible") {
      startTimer();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [corporateActions, historyBars, historyCacheMeta, hydrated]);

  const hasActiveSession = Object.values(quotes).some((quote) => quote.session !== "closed");
  const effectiveUpdateMinutes = hasActiveSession ? Math.max(updateFrequency, 10) : Math.max(updateFrequency, 60);
  const scheduledMarketRefresh = useCallback(async () => {
    if (persistenceMode === "cloud") {
      let appliedSnapshot = false;
      try {
        const [snapshot] = await Promise.all([
          loadServerMarketSnapshot({
            includeIntraday: false,
            allowPersistentCache: allowPersistentMarketCache,
          }),
          refreshServerUsIntraday(true),
        ]);
        if (snapshot) appliedSnapshot = applyServerMarketSnapshot(snapshot);
      } catch { /* Fall through to the live client refresh path. */ }
      if (appliedSnapshot) return;
    }
    await loadQuotes(false, "scheduled");
  }, [allowPersistentMarketCache, applyServerMarketSnapshot, loadQuotes, persistenceMode, refreshServerUsIntraday]);

  const lastAutoRefreshRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!autoRefresh) return;
    let timer: number | null = null;
    const intervalMs = effectiveUpdateMinutes * 60_000;

    const scheduleNext = (delayMs: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        if (document.visibilityState === "visible") {
          lastAutoRefreshRef.current = Date.now();
          await scheduledMarketRefresh();
          scheduleNext(effectiveUpdateMinutes * 60_000);
        }
      }, delayMs);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshServerUsIntraday(true);
        const elapsed = Date.now() - lastAutoRefreshRef.current;
        if (elapsed >= intervalMs) {
          lastAutoRefreshRef.current = Date.now();
          void scheduledMarketRefresh();
          scheduleNext(intervalMs);
        } else {
          scheduleNext(intervalMs - elapsed);
        }
      } else {
        if (timer != null) {
          window.clearTimeout(timer);
          timer = null;
        }
      }
    };

    if (document.visibilityState === "visible") {
      scheduleNext(intervalMs);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [autoRefresh, effectiveUpdateMinutes, scheduledMarketRefresh]);

  const usdJpyBenchmark = benchmarks.find((benchmark) => benchmark.id === "usd-jpy");
  const fxHistory = useMemo(() => historyBars.filter((bar) => bar.securityId === FX_SECURITY_ID).sort((a, b) => a.date.localeCompare(b.date)), [historyBars]);
  const fxIntradayBars = useMemo(
    () => intradayBars.filter((bar) => bar.securityId === FX_SECURITY_ID).sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [intradayBars],
  );
  const quoteUsdJpy = quotes[FX_SECURITY_ID]?.price != null ? Number(quotes[FX_SECURITY_ID].price) : null;
  const historyUsdJpy = fxHistory.at(-1)?.close != null ? Number(fxHistory.at(-1)!.close) : null;
  const storedFx = useMemo(() => {
    try {
      const value = JSON.parse(preferenceStorage.getItem("kabutora-usdjpy-observation-v1") ?? "null") as { rate: number; source: string; asOf: string } | null;
      return value && validUsdJpy(value.rate) && value.source && Number.isFinite(Date.parse(value.asOf)) ? value : null;
    } catch { return null; }
  }, [preferenceStorage]);
  const currentFx = validUsdJpy(usdJpyBenchmark?.value)
    ? { rate: usdJpyBenchmark.value, source: "market-benchmark", asOf: usdJpyBenchmark.marketTimestamp }
    : validUsdJpy(quoteUsdJpy)
      ? { rate: quoteUsdJpy, source: "market-quote", asOf: quotes[FX_SECURITY_ID].marketTimestamp }
      : validUsdJpy(historyUsdJpy)
        ? { rate: historyUsdJpy, source: "daily-history", asOf: fxHistory.at(-1)!.date }
        : storedFx;
  const currentUsdJpy = currentFx?.rate ?? null;
  useEffect(() => {
    if (currentFx) preferenceStorage.setItem("kabutora-usdjpy-observation-v1", JSON.stringify(currentFx));
  }, [currentFx?.rate, currentFx?.asOf, currentFx?.source, preferenceStorage]);

  const quotePreviousUsdJpy = quotes[FX_SECURITY_ID]?.previousRegularClose != null ? Number(quotes[FX_SECURITY_ID].previousRegularClose) : null;
  const benchmarkPreviousUsdJpy = validUsdJpy(currentUsdJpy) && usdJpyBenchmark?.changeRatio != null && 1 + usdJpyBenchmark.changeRatio > 0
    ? new Decimal(currentUsdJpy).div(new Decimal(1).plus(usdJpyBenchmark.changeRatio)).toNumber()
    : null;
  const previousUsdJpy = validUsdJpy(quotePreviousUsdJpy)
    ? quotePreviousUsdJpy
    : validUsdJpy(benchmarkPreviousUsdJpy)
      ? benchmarkPreviousUsdJpy
      : currentUsdJpy;

  const fxAtDate = useCallback((date: string) => {
    return historicalFxRateAtDate(fxHistory, date, validUsdJpy(currentUsdJpy) ? currentUsdJpy : null, true, todayKey);
  }, [currentUsdJpy, fxHistory, todayKey]);

  const fxAtTimestamp = useCallback((timestamp: string) => {
    return historicalFxRateAtTimestamp(fxIntradayBars, fxHistory, timestamp, validUsdJpy(currentUsdJpy) ? currentUsdJpy : null, true, todayKey);
  }, [currentUsdJpy, fxHistory, fxIntradayBars, todayKey]);

  const currentPreferences = useMemo<UserPreferences>(() => ({
    theme: dark ? "dark" : "light",
    accentTheme,
    autoRefresh,
    updateFrequency,
    displayCurrency,
    summaryMarketFilter,
    summaryBrokerFilter,
    dividendMarketFilter,
    dividendDisplayCurrency,
    dividendPeriod,
    dividendTaxMode,
    dividendActiveTab,
    summaryAmountsVisible,
    hideScrollbar,
    summaryRange: range,
    summaryCustomRange: customRange,
    priceAlertThreshold,
    acknowledgedActions: acknowledgedActionIds,
    readNotifications: readNotificationIds,
    notificationHistory,
    lastUsdJpy: validUsdJpy(currentUsdJpy) ? currentUsdJpy : undefined,
    updatedAt: new Date(lastLocalPrefTimestampRef.current || Date.now()).toISOString(),
  }), [accentTheme, acknowledgedActionIds, autoRefresh, currentUsdJpy, customRange, dark, displayCurrency, dividendActiveTab, dividendDisplayCurrency, dividendMarketFilter, dividendPeriod, dividendTaxMode, hideScrollbar, notificationHistory, priceAlertThreshold, range, readNotificationIds, summaryAmountsVisible, summaryBrokerFilter, summaryMarketFilter, updateFrequency]);

  const incomingPrefTimeRef = useRef<string>("");
  useEffect(() => {
    if (!seed.preferences) return;
    const p = seed.preferences;
    const incomingTime = p.updatedAt ? Date.parse(p.updatedAt) || 0 : 0;
    incomingPrefTimeRef.current = p.updatedAt ?? "";
    // Event replay already resolves each preference independently using its
    // per-field sequence. A page-wide timestamp check here would incorrectly
    // discard a remote USD change merely because this device had more recently
    // changed the independent JP/US market filter.
    if (incomingTime) lastLocalPrefTimestampRef.current = Math.max(lastLocalPrefTimestampRef.current, incomingTime);

    const canApplyField = (field: keyof UserPreferences) => {
      const localTime = localPrefTimestampsRef.current[field];
      if (!localTime) return true;
      const fieldSeq = seed.sync?.preferenceSequences?.[field] ?? incomingTime;
      if (fieldSeq >= localTime) {
        delete localPrefTimestampsRef.current[field];
        return true;
      }
      return false;
    };

    if (canApplyField("theme") && p.theme) setDark(p.theme === "dark");
    if (canApplyField("accentTheme") && p.accentTheme && ["graphite", "blue", "forest", "plum"].includes(p.accentTheme)) setAccentTheme(p.accentTheme);
    if (canApplyField("autoRefresh") && p.autoRefresh !== undefined) setAutoRefresh(p.autoRefresh);
    if (canApplyField("updateFrequency") && p.updateFrequency && [10, 15, 30, 60].includes(p.updateFrequency)) setUpdateFrequency(p.updateFrequency);
    if (canApplyField("displayCurrency") && p.displayCurrency && ["JPY", "USD", "NATIVE"].includes(p.displayCurrency)) setDisplayCurrency(p.displayCurrency);
    if (canApplyField("summaryMarketFilter") && p.summaryMarketFilter && ["ALL", "JP", "US", "FUNDS_INDEXES"].includes(p.summaryMarketFilter)) setSummaryMarketFilter(p.summaryMarketFilter);
    if (canApplyField("summaryBrokerFilter") && p.summaryBrokerFilter !== undefined) setSummaryBrokerFilter(p.summaryBrokerFilter);
    if (canApplyField("dividendMarketFilter") && p.dividendMarketFilter && ["ALL", "JP", "US", "FUNDS_INDEXES"].includes(p.dividendMarketFilter)) setDividendMarketFilter(p.dividendMarketFilter);
    if (canApplyField("dividendDisplayCurrency") && p.dividendDisplayCurrency && ["JPY", "USD", "NATIVE"].includes(p.dividendDisplayCurrency)) setDividendDisplayCurrency(p.dividendDisplayCurrency);
    if (canApplyField("dividendPeriod") && p.dividendPeriod !== undefined) setDividendPeriod(p.dividendPeriod);
    if (canApplyField("dividendTaxMode") && p.dividendTaxMode) setDividendTaxMode(p.dividendTaxMode);
    if (canApplyField("dividendActiveTab") && p.dividendActiveTab) setDividendActiveTab(p.dividendActiveTab);
    if (canApplyField("summaryAmountsVisible") && p.summaryAmountsVisible !== undefined) setSummaryAmountsVisible(p.summaryAmountsVisible);
    if (canApplyField("hideScrollbar") && p.hideScrollbar !== undefined) setHideScrollbar(p.hideScrollbar);
    if (canApplyField("summaryRange") && p.summaryRange) setRange(p.summaryRange);
    if (canApplyField("summaryCustomRange") && p.summaryCustomRange !== undefined) setCustomRange(p.summaryCustomRange);
    if (canApplyField("priceAlertThreshold") && p.priceAlertThreshold && (PRICE_ALERT_THRESHOLDS as readonly number[]).includes(p.priceAlertThreshold)) setPriceAlertThreshold(p.priceAlertThreshold);
    if (Array.isArray(p.acknowledgedActions)) {
      setAcknowledgedActionIds((current) => {
        const merged = [...new Set([...current, ...p.acknowledgedActions!])];
        return merged.length === current.length && current.every((id, idx) => id === merged[idx]) ? current : merged;
      });
    }
    if (Array.isArray(p.readNotifications)) {
      setReadNotificationIds((current) => {
        const merged = [...new Set([...current, ...p.readNotifications!])];
        return merged.length === current.length && current.every((id, idx) => id === merged[idx]) ? current : merged;
      });
    }
    if (Array.isArray(p.notificationHistory)) setNotificationHistory(p.notificationHistory);
  }, [seed.preferences]);

  useEffect(() => {
    if (!seed.watchlist || !Array.isArray(seed.watchlist)) return;
    setWatchlist(seed.watchlist);
  }, [seed.watchlist]);

  const lastPushedPreferencesRef = useRef<string>("");
  useEffect(() => {
    if (!hydrated) return;
    const { updatedAt: _, lastUsdJpy: __, ...comparable } = currentPreferences;
    const json = JSON.stringify(comparable);
    if (lastPushedPreferencesRef.current === "") {
      lastPushedPreferencesRef.current = json;
      return;
    }
    if (json === lastPushedPreferencesRef.current) return;

    const incomingTime = incomingPrefTimeRef.current ? Date.parse(incomingPrefTimeRef.current) || 0 : 0;
    if (incomingTime && incomingTime > lastLocalPrefTimestampRef.current) {
      lastPushedPreferencesRef.current = json;
      return;
    }

    // Capture edit clocks now. A local optimistic cloud replay may acknowledge
    // the change before the debounce fires and clear the live ref.
    const preferenceSequences = Object.fromEntries(
      Object.keys(comparable).flatMap((key) => {
        const sequence = localPrefTimestampsRef.current[key as keyof UserPreferences];
        return sequence ? [[key, sequence]] : [];
      }),
    );
    const previous = JSON.parse(lastPushedPreferencesRef.current) as UserPreferences;
    const changed = Object.fromEntries(Object.entries(comparable).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof UserPreferences]))) as UserPreferences;
    lastPushedPreferencesRef.current = json;
    if (currentPreferences.updatedAt) incomingPrefTimeRef.current = currentPreferences.updatedAt;
    const changedSequences = Object.fromEntries(Object.entries(preferenceSequences).filter(([key]) => key in changed));
    void onPreferencesChange?.({ ...changed, updatedAt: currentPreferences.updatedAt, ...(Object.keys(changedSequences).length ? { preferenceSequences: changedSequences } : {}) });
  }, [currentPreferences, hydrated, onPreferencesChange]);

  const nativeMarketSecurities = useMemo(
    () => allSecurities.map((security) => {
      const quote = resolveQuoteFromRecord(quotes, security.id);
      const nameSource = {
        ...security,
        brandName: quote?.brandName ?? security.brandName,
        shortName: quote?.shortName ?? security.shortName,
        longName: quote?.longName ?? security.longName,
      };
      return {
        ...security,
        name: companyDisplayName(nameSource),
        legalName: companyLegalName(nameSource),
        quote,
      };
    }),
    [allSecurities, quotes],
  );
  const rawSecurityMap = useMemo(() => {
    const map = new Map<string, typeof nativeMarketSecurities[number]>();
    for (const security of nativeMarketSecurities) {
      map.set(security.id, security);
      for (const variant of domainSecurityIdVariants(security.id)) {
        if (!map.has(variant)) {
          map.set(variant, { ...security, id: variant });
        }
      }
    }
    return map;
  }, [nativeMarketSecurities]);
  const marketSecurities = useMemo(() => nativeMarketSecurities.map((security) => {
    if (displayCurrency === "NATIVE") return security;
    const nativeCurrency = security.currency;
    const quote = security.quote;
    if (!quote) return { ...security, nativeCurrency, currency: displayCurrency };
    const price = convertAmount(quote.price, nativeCurrency, displayCurrency, currentUsdJpy);
    const previousRegularClose = convertAmount(quote.previousRegularClose, nativeCurrency, displayCurrency, previousUsdJpy);
    if (price == null) return { ...security, nativeCurrency, currency: displayCurrency, quote: undefined };
    return {
      ...security,
      nativeCurrency,
      currency: displayCurrency,
      quote: {
        ...quote,
        price,
        ...(previousRegularClose != null ? { previousRegularClose } : {}),
        ...(convertAmount(quote.dayOpen, nativeCurrency, displayCurrency, currentUsdJpy) != null ? { dayOpen: convertAmount(quote.dayOpen, nativeCurrency, displayCurrency, currentUsdJpy)! } : {}),
        ...(convertAmount(quote.dayHigh, nativeCurrency, displayCurrency, currentUsdJpy) != null ? { dayHigh: convertAmount(quote.dayHigh, nativeCurrency, displayCurrency, currentUsdJpy)! } : {}),
        ...(convertAmount(quote.dayLow, nativeCurrency, displayCurrency, currentUsdJpy) != null ? { dayLow: convertAmount(quote.dayLow, nativeCurrency, displayCurrency, currentUsdJpy)! } : {}),
      },
    };
  }), [currentUsdJpy, displayCurrency, nativeMarketSecurities, previousUsdJpy]);
  const securityMap = useMemo(() => {
    const map = new Map<string, typeof marketSecurities[number]>();
    for (const security of marketSecurities) {
      map.set(security.id, security);
      for (const variant of domainSecurityIdVariants(security.id)) {
        if (!map.has(variant)) {
          map.set(variant, { ...security, id: variant });
        }
      }
    }
    return map;
  }, [marketSecurities]);
  const brokerOptions = useMemo(() => [...new Set(activeAccounts.map((account) => account.broker).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [activeAccounts]);
  const summaryBrokerTransactions = useMemo(() => calculationBrokerFilter === "ALL" ? calculationTransactions : calculationTransactions.filter((transaction) => {
    const account = accountMap.get(transaction.accountId);
    return account?.broker === calculationBrokerFilter || transaction.original?.broker === calculationBrokerFilter;
  }), [accountMap, calculationBrokerFilter, calculationTransactions]);
  const summaryViewInputs = useMemo(() => {
    type SummaryViewInput = { transactions: typeof summaryBrokerTransactions; currency: "JPY" | "USD" };
    const inputs = new Map<PortfolioFilter, SummaryViewInput>();
    for (const filter of ["ALL", "JP", "US", "FUNDS_INDEXES"] as const) {
      const visibleTransactions = filter === "ALL" ? summaryBrokerTransactions : summaryBrokerTransactions.filter((transaction) => {
        const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
        if (security) return securityMatchesPortfolioFilter(security, filter);
        if (filter === "FUNDS_INDEXES") return false;
        return (transaction.tradeCurrency === "USD" ? "US" : "JP") === filter;
      });
      let currency: "JPY" | "USD";
      if (displayCurrency === "USD" || displayCurrency === "JPY") {
        currency = displayCurrency;
      } else {
        const netQuantityBySecurity = new Map<string, Decimal>();
        for (const transaction of visibleTransactions) {
          if (!transaction.securityId) continue;
          const current = netQuantityBySecurity.get(transaction.securityId) ?? new Decimal(0);
          const quantity = new Decimal(transaction.quantity || 0);
          netQuantityBySecurity.set(transaction.securityId, transaction.type === "BUY" ? current.plus(quantity) : current.minus(quantity));
        }
        const distinctCurrencies = new Set<string>();
        for (const [securityId, quantity] of netQuantityBySecurity) {
          if (!quantity.gt(0)) continue;
          const security = rawSecurityMap.get(securityId);
          distinctCurrencies.add(security?.currency ?? (security as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(security, securityId) ? "USD" : "JPY"));
        }
        if (!distinctCurrencies.size) {
          for (const transaction of visibleTransactions) {
            const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
            const nativeCurrency = transaction.tradeCurrency ?? security?.currency ?? (security as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(security, transaction.securityId ?? undefined) ? "USD" : null);
            if (nativeCurrency) distinctCurrencies.add(nativeCurrency);
          }
        }
        const soleCurrency = distinctCurrencies.size === 1 ? [...distinctCurrencies][0] : null;
        currency = soleCurrency === "USD" || soleCurrency === "JPY"
          ? soleCurrency
          : filter === "US"
            ? "USD"
            : seed.portfolio.baseCurrency === "USD" && filter === "ALL"
              ? "USD"
              : "JPY";
      }
      inputs.set(filter, { transactions: visibleTransactions, currency });
    }
    return inputs;
  }, [displayCurrency, rawSecurityMap, seed.portfolio.baseCurrency, summaryBrokerTransactions]);
  const activeSummaryViewInput = summaryViewInputs.get(calculationMarketFilter)!;
  const summaryVisibleTransactions = activeSummaryViewInput.transactions;
  const effectiveSummaryCurrency = activeSummaryViewInput.currency;

  const allConvertedTransactions = useMemo(() => calculationTransactions.flatMap((transaction) => {
    if (displayCurrency === "NATIVE") return [transaction];
    const sec = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
    const tradeCurrency = transaction.tradeCurrency ?? sec?.currency ?? (sec as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(sec, transaction.securityId ?? undefined) ? "USD" : "JPY");
    const rate = fxAtDate(transaction.tradeDate) ?? (validUsdJpy(currentUsdJpy) ? currentUsdJpy : null);
    const grossAmount = convertAmount(transaction.grossAmount, tradeCurrency, displayCurrency, rate);
    const pricePerShare = convertAmount(transaction.pricePerShare, tradeCurrency, displayCurrency, rate);
    if (tradeCurrency !== displayCurrency && (!validUsdJpy(rate) || (transaction.grossAmount != null && grossAmount == null))) return [];
    return [{ ...transaction, grossAmount, pricePerShare, tradeCurrency: displayCurrency }];
  }), [calculationTransactions, currentUsdJpy, displayCurrency, fxAtDate, rawSecurityMap]);
  const monitoredSecurityIds = useMemo(() => new Set([
    ...calculationTransactions.map((t) => t.securityId).filter((id): id is string => Boolean(id)),
    ...watchlist.map((item) => item.id),
  ]), [calculationTransactions, watchlist]);

  const derivedNotifications = useMemo(() => derivePortfolioNotifications({
    transactions: calculationTransactions,
    securities: nativeMarketSecurities,
    actions: applicableCorporateActions,
    bars: historyBars,
    intradayBars,
    externalNotices: seededMarketNotices,
    priceMoveThreshold: priceAlertThreshold / 100,
    monitoredSecurityIds,
  }), [applicableCorporateActions, calculationTransactions, historyBars, intradayBars, monitoredSecurityIds, nativeMarketSecurities, priceAlertThreshold, seededMarketNotices]);
  const portfolioNotifications = useMemo(() => {
    const all = mergePortfolioNotifications(notificationHistory, derivedNotifications);
    const threshold = priceAlertThreshold / 100;
    return all.filter((notice) => {
      if (notice.type === "PRICE_UP" || notice.type === "PRICE_DOWN") {
        if (notice.changeRatio != null) {
          return Math.abs(Number(notice.changeRatio)) >= threshold;
        }
      }
      return true;
    });
  }, [derivedNotifications, notificationHistory, priceAlertThreshold]);
  useEffect(() => {
    if (!hydrated || !derivedNotifications.length) return;
    setNotificationHistory((current) => {
      const merged = mergePortfolioNotifications(current, derivedNotifications);
      return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
    });
  }, [derivedNotifications, hydrated]);
  const visibleSecurityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const transaction of summaryVisibleTransactions) {
      if (transaction.securityId) {
        ids.add(transaction.securityId);
        ids.add(canonicalDomainSecurityId(transaction.securityId));
      }
    }
    return ids;
  }, [summaryVisibleTransactions]);
  const allTransactionSecurityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const transaction of transactions) {
      if (transaction.securityId) {
        ids.add(transaction.securityId);
        ids.add(canonicalDomainSecurityId(transaction.securityId));
      }
    }
    return ids;
  }, [transactions]);
  const unreadNotificationCount = useMemo(() => {
    const read = new Set(readNotificationIds);
    return portfolioNotifications.filter((notice) => !read.has(notice.id)).length;
  }, [portfolioNotifications, readNotificationIds]);
  const allRecognizedDistributions = useMemo(() => distributions.filter((event) => {
    const recognitionDate = (event.paymentDate ?? event.exDate ?? event.recordDate ?? "").slice(0, 10);
    return Boolean(recognitionDate) && recognitionDate <= todayKey;
  }), [distributions, todayKey]);
  const allNativeDividendSummary = useMemo(() => calculateDividendIncome(calculationTransactions, allRecognizedDistributions, applicableCorporateActions, todayKey), [applicableCorporateActions, allRecognizedDistributions, calculationTransactions, todayKey]);

  const effectiveDividendCurrency: "JPY" | "USD" = useMemo(() => {
    if (dividendDisplayCurrency === "USD") return "USD";
    if (dividendDisplayCurrency === "JPY") return "JPY";
    const receiptsToInspect = allNativeDividendSummary.receipts.filter((receipt) => {
      const security = receipt.securityId ? rawSecurityMap.get(receipt.securityId) : null;
      if (dividendMarketFilter === "ALL") return true;
      if (security) return securityMatchesPortfolioFilter(security, dividendMarketFilter);
      if (dividendMarketFilter === "FUNDS_INDEXES") return false;
      return (receipt.currency === "USD" ? "US" : "JP") === dividendMarketFilter;
    });

    const distinctCurrencies = new Set<string>();
    for (const receipt of receiptsToInspect) {
      const sec = receipt.securityId ? rawSecurityMap.get(receipt.securityId) : null;
      const curr = receipt.currency ?? (receipt as { sourceCurrency?: string })?.sourceCurrency ?? sec?.currency ?? (sec as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(sec, receipt.securityId) ? "USD" : "JPY");
      if (curr) distinctCurrencies.add(curr);
    }

    if (distinctCurrencies.size === 0) {
      for (const t of summaryVisibleTransactions) {
        const sec = t.securityId ? rawSecurityMap.get(t.securityId) : null;
        const curr = t.tradeCurrency ?? sec?.currency ?? (sec as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(sec, t.securityId ?? undefined) ? "USD" : null);
        if (curr) distinctCurrencies.add(curr);
      }
    }

    if (distinctCurrencies.size > 1) {
      return "JPY";
    }
    if (distinctCurrencies.size === 1) {
      const single = [...distinctCurrencies][0];
      if (single === "USD" || single === "JPY") return single;
    }
    if (dividendMarketFilter === "US") return "USD";
    return seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY";
  }, [allNativeDividendSummary.receipts, calculationTransactions, dividendDisplayCurrency, dividendMarketFilter, rawSecurityMap, seed.portfolio.baseCurrency]);

  const allConvertedDividendReceipts = useMemo(() => allNativeDividendSummary.receipts.flatMap((receipt) => {
    const rate = fxAtDate(receipt.recognitionDate) ?? (validUsdJpy(currentUsdJpy) ? currentUsdJpy : null);
    const grossAmount = convertAmount(receipt.grossAmount, receipt.currency, effectiveDividendCurrency, rate);
    if (grossAmount == null) return [receipt];
    return [{
      ...receipt,
      sourceCurrency: receipt.sourceCurrency ?? receipt.currency,
      sourceGrossAmount: receipt.sourceGrossAmount ?? receipt.grossAmount,
      grossAmount: grossAmount.toString(),
      currency: effectiveDividendCurrency,
    }];
  }), [allNativeDividendSummary.receipts, currentUsdJpy, effectiveDividendCurrency, fxAtDate, fxHistory]);

  const dividendFxUnavailable = allConvertedDividendReceipts.some((receipt) => receipt.currency !== effectiveDividendCurrency);
  const summaryVisibleSecurityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const transaction of summaryVisibleTransactions) {
      if (transaction.securityId) {
        ids.add(transaction.securityId);
        ids.add(canonicalDomainSecurityId(transaction.securityId));
      }
    }
    return ids;
  }, [summaryVisibleTransactions]);

  const allSummaryConvertedDividendReceipts = useMemo(() => {
    return allNativeDividendSummary.receipts.flatMap((receipt) => {
      const rate = fxAtDate(receipt.recognitionDate) ?? (validUsdJpy(currentUsdJpy) ? currentUsdJpy : null);
      const grossAmount = convertAmount(receipt.grossAmount, receipt.currency, effectiveSummaryCurrency, rate);
      if (grossAmount == null) return [];
      return [{
        ...receipt,
        sourceCurrency: receipt.sourceCurrency ?? receipt.currency,
        sourceGrossAmount: receipt.sourceGrossAmount ?? receipt.grossAmount,
        grossAmount: grossAmount.toString(),
        currency: effectiveSummaryCurrency,
      }];
    });
  }, [allNativeDividendSummary.receipts, currentUsdJpy, effectiveSummaryCurrency, fxAtDate, fxHistory]);
  const summaryConvertedDividendReceipts = useMemo(() => allSummaryConvertedDividendReceipts.filter((receipt) =>
    (calculationBrokerFilter === "ALL" || accountMap.get(receipt.accountId)?.broker === calculationBrokerFilter)
    && (summaryVisibleSecurityIds.has(receipt.securityId) || summaryVisibleSecurityIds.has(canonicalDomainSecurityId(receipt.securityId)))
  ), [accountMap, allSummaryConvertedDividendReceipts, calculationBrokerFilter, summaryVisibleSecurityIds]);

  const summaryDividendSummary = useMemo(() => summarizeDividendReceipts(summaryConvertedDividendReceipts), [summaryConvertedDividendReceipts]);

  const summaryNativeDividendReceipts = useMemo(() => {
    return allNativeDividendSummary.receipts.filter((receipt) =>
      (calculationBrokerFilter === "ALL" || accountMap.get(receipt.accountId)?.broker === calculationBrokerFilter)
      && (summaryVisibleSecurityIds.has(receipt.securityId) || summaryVisibleSecurityIds.has(canonicalDomainSecurityId(receipt.securityId)))
    );
  }, [accountMap, allNativeDividendSummary.receipts, calculationBrokerFilter, summaryVisibleSecurityIds]);

  const stableEmptyReceiptsRef = useRef<typeof allNativeDividendSummary.receipts>([]);
  const stableDividendReceipts = useMemo(() => {
    if (!allNativeDividendSummary.receipts.length) return stableEmptyReceiptsRef.current;
    return allNativeDividendSummary.receipts;
  }, [allNativeDividendSummary.receipts]);

  const historyDataset = useMemo<HistoryDataset>(() => ({
    transactions: calculationTransactions,
    securities: nativeMarketSecurities,
    bars: historyBars,
    corporateActions: applicableCorporateActions,
    distributions: [],
    dividendReceipts: stableDividendReceipts,
    fx: { current: currentUsdJpy, previous: previousUsdJpy },
  }), [calculationTransactions, nativeMarketSecurities, historyBars, applicableCorporateActions, stableDividendReceipts, currentUsdJpy, previousUsdJpy]);
  const historyRequest = useMemo(() => ({ dataset: historyDataset, selection: {
    transactionIds: summaryVisibleTransactions.map((item) => item.id), throughDate: todayKey, currency: effectiveSummaryCurrency, reconcile: calculationMarketFilter === "ALL",
  } }), [calculationMarketFilter, historyDataset, summaryVisibleTransactions, todayKey, effectiveSummaryCurrency]);

  const selectionKeyFor = useCallback((filter: PortfolioFilter, currency: "JPY" | "USD") =>
    `${currency}:${filter}:${calculationBrokerFilter}:${todayKey}`,
    [calculationBrokerFilter, todayKey]
  );
  const selectionKey = selectionKeyFor(calculationMarketFilter, effectiveSummaryCurrency);
  const historyCalculationCacheRef = useRef<Map<string, { dataset: HistoryDataset; result: PortfolioCalculationResult }>>(new Map());
  const lastHistoryDatasetRef = useRef<HistoryDataset | null>(null);
  if (lastHistoryDatasetRef.current !== historyDataset) {
    lastHistoryDatasetRef.current = historyDataset;
  }

  const historyCalculatorRef = useRef<PortfolioHistoryCalculator | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [completedHistory, setCompletedHistory] = useState<{ request: typeof historyRequest; result: PortfolioCalculationResult; failed: boolean } | null>(null);

  const cachedCalculation = historyCalculationCacheRef.current.get(selectionKey);
  // A selection cache is only valid for the exact market/history dataset that
  // produced it. Reusing a JP/US result after fresh quotes arrive makes the
  // filter appear stuck until the user changes it again.
  const cachedCalculationResult = cachedCalculation?.dataset === historyRequest.dataset ? cachedCalculation.result : null;
  const activeCalculationResult = completedHistory?.request === historyRequest
    ? completedHistory.result
    : (cachedCalculationResult ?? null);
  const historyCalculationPending = !activeCalculationResult;
  const reconstructedHistory = useMemo(() => ((activeCalculationResult?.points ?? completedHistory?.result?.points) ?? []), [activeCalculationResult, completedHistory]);

  useEffect(() => {
    const calculator = new PortfolioHistoryCalculator();
    historyCalculatorRef.current = calculator;
    return () => { calculator.dispose(); historyCalculatorRef.current = null; };
  }, []);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const runReconstruction = () => {
      controller?.abort();
      if (!active || document.visibilityState === "hidden" || !historyCalculatorRef.current) return;
      const cached = historyCalculationCacheRef.current.get(selectionKey);
      if (cached && cached.dataset === historyRequest.dataset) {
        setCompletedHistory({ request: historyRequest, result: cached.result, failed: false });
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      void historyCalculatorRef.current.calculate(historyRequest.dataset, historyRequest.selection, signal).then((result) => {
        if (active && !signal.aborted) {
          if (lastHistoryDatasetRef.current === historyRequest.dataset) {
            historyCalculationCacheRef.current.set(selectionKey, { dataset: historyRequest.dataset, result });
          }
          setCompletedHistory({ request: historyRequest, result, failed: false });
        }
      }).catch((error: unknown) => {
        if (active && !signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
          setCompletedHistory({ request: historyRequest, result: emptyPortfolioCalculation, failed: true });
        }
      });
    };
    runReconstruction();
    document.addEventListener("visibilitychange", runReconstruction);
    return () => {
      active = false;
      controller?.abort();
      document.removeEventListener("visibilitychange", runReconstruction);
    };
  }, [historyRequest, historyAttempt, selectionKey]);

  useEffect(() => {
    const markPreloaded = (ready: boolean) => {
      marketViewsPreloadedRef.current = ready;
      if (workspaceRef.current) workspaceRef.current.dataset.marketViewsPreloaded = String(ready);
    };
    markPreloaded(false);
    if (!activeCalculationResult || completedHistory?.failed || typeof Worker === "undefined" || document.visibilityState === "hidden") return;
    const pending = (["ALL", "JP", "US", "FUNDS_INDEXES"] as const).filter((filter) => {
      if (filter === calculationMarketFilter) return false;
      const input = summaryViewInputs.get(filter)!;
      const cached = historyCalculationCacheRef.current.get(selectionKeyFor(filter, input.currency));
      return cached?.dataset !== historyDataset;
    });
    if (!pending.length) {
      markPreloaded(true);
      return;
    }
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let active = true;
    let controller: AbortController | null = null;
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const scheduleNext = () => {
      if (!active) return;
      if (!pending.length) {
        markPreloaded(true);
        return;
      }
      const start = () => { void warmNext(); };
      if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(start, { timeout: 120 });
      else timeoutId = window.setTimeout(start, 20);
    };
    const warmNext = async () => {
      if (!active || document.visibilityState === "hidden" || !historyCalculatorRef.current) return;
      const filter = pending.shift();
      if (!filter) return;
      const input = summaryViewInputs.get(filter)!;
      const key = selectionKeyFor(filter, input.currency);
      const cached = historyCalculationCacheRef.current.get(key);
      if (cached?.dataset === historyDataset) {
        scheduleNext();
        return;
      }
      controller = new AbortController();
      try {
        const result = await historyCalculatorRef.current.calculate(historyDataset, {
          transactionIds: input.transactions.map((transaction) => transaction.id),
          throughDate: todayKey,
          currency: input.currency,
          reconcile: filter === "ALL",
        }, controller.signal, "background");
        if (active && lastHistoryDatasetRef.current === historyDataset) {
          historyCalculationCacheRef.current.set(key, { dataset: historyDataset, result });
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) console.warn("[MARKET_VIEW_PRELOAD_FAILED]", error);
      }
      scheduleNext();
    };
    scheduleNext();
    return () => {
      active = false;
      controller?.abort();
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (idleId != null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [activeCalculationResult, calculationMarketFilter, completedHistory?.failed, historyDataset, selectionKeyFor, summaryViewInputs, todayKey]);

  // Summary calculation is Decimal-heavy. It already runs in the domain
  // worker together with history reconstruction, so doing it twice again on
  // the main thread made every filter interaction block a frame. Retain the
  // last complete result until the worker atomically supplies the new view.
  const calculation = activeCalculationResult ?? completedHistory?.result ?? emptyPortfolioCalculation;
  const precalculatedSummary = completedHistory?.result?.filterSummaries?.[calculationMarketFilter];
  const visibleSummary = activeCalculationResult?.summary
    ?? (calculationMarketFilter === "ALL" ? calculation.summary : (precalculatedSummary ?? calculation.summary));
  const nativeSummary = activeCalculationResult?.nativeSummary ?? calculation.nativeSummary;
  const securityScope = summaryVisibleTransactions.some((transaction) => transaction.securityId);
  const activeSummary = useMemo(() => projectStockPortfolio(visibleSummary), [visibleSummary]);
  const marketReconciliation = calculation.reconciliation;
  const visibleConversionDates = [
    ...summaryVisibleTransactions.filter((transaction) => transaction.tradeCurrency !== effectiveSummaryCurrency).map((transaction) => transaction.tradeDate.slice(0, 10)),
    ...summaryNativeDividendReceipts.filter((receipt) => receipt.currency !== effectiveSummaryCurrency).map((receipt) => receipt.recognitionDate.slice(0, 10)),
  ].filter(Boolean).sort();
  const fxHistoryComplete = !visibleConversionDates.length || Boolean((fxHistory[0]?.date && fxHistory[0].date <= visibleConversionDates[0]) || fxHistory.length > 0 || validUsdJpy(currentUsdJpy));
  const fxConversionReady = !visibleConversionDates.length || (validUsdJpy(currentUsdJpy) && fxHistoryComplete);
  const fxEstimated = visibleConversionDates.some((date) => !fxHistory.length || date < fxHistory[0]!.date || (date > fxHistory.at(-1)!.date && date < todayKey)) || Boolean(currentFx && Date.now() - Date.parse(currentFx.asOf) > 72 * 60 * 60 * 1000);
  const valuationComplete = fxConversionReady && marketReconciliation.valid && (activeSummary?.unpricedSecurityCount ?? 0) === 0 && ((activeSummary?.pricedSecurityCount ?? 0) > 0 || !securityScope);
  const totalValue = valuationComplete && activeSummary?.totalValue != null ? Number(activeSummary.totalValue) : null;
  const dayGain = valuationComplete && activeSummary?.dayGain != null ? Number(activeSummary.dayGain) : null;
  const previousValue = totalValue != null && dayGain != null && activeSummary?.totalValue != null && activeSummary?.dayGain != null
    ? new Decimal(activeSummary.totalValue).minus(activeSummary.dayGain)
    : null;
  const dayReturn = previousValue && !previousValue.isZero() && dayGain != null && activeSummary?.dayGain != null
    ? new Decimal(activeSummary.dayGain).div(previousValue).toNumber()
    : null;
  const totalGain = activeSummary?.totalGain != null ? Number(activeSummary.totalGain) : null;
  const totalReturn = valuationComplete && activeSummary?.costBasis && !new Decimal(activeSummary.costBasis).isZero() && activeSummary?.totalGain != null
    ? new Decimal(activeSummary.totalGain).div(activeSummary.costBasis).toNumber()
    : null;

  const displayHoldings = useMemo(() => {
    const buildFallback = (securityId: string) => {
      const isUs = isUsSecurity(null, securityId);
      const isFund = securityId.startsWith("sec-fund-") || securityId.includes("-fund-");
      const displaySymbol = securityId.replace(/^sec-(?:us-|jp-)?/i, "").replace(/-(?:xtks|tse|xnas|xnys|arcx|xase|bats|otcm)$/i, "").toUpperCase();
      return {
        id: securityId,
        displaySymbol,
        name: displaySymbol,
        legalName: displaySymbol,
        assetType: (isFund ? "fund" : "stock") as "fund" | "stock" | "index",
        country: isUs ? "US" : "JP",
        exchangeMic: isUs ? "XNAS" : "XTKS",
        currency: isUs ? "USD" : "JPY",
        exchangeLabel: isUs ? "NASDAQ" : "東証",
        priceUnit: "1",
        quote: undefined as RemoteQuote | undefined,
      };
    };

    const resolveSecurity = (securityId: string) => {
      const canonical = canonicalDomainSecurityId(securityId);
      const existing =
        securityMap.get(securityId) ??
        securityMap.get(canonical) ??
        rawSecurityMap.get(securityId) ??
        rawSecurityMap.get(canonical) ??
        seed.securities.find((s) => s.id === securityId || s.id === canonical);
      const fallback = buildFallback(securityId);
      if (existing) {
        return {
          ...existing,
          displaySymbol: existing.displaySymbol || fallback.displaySymbol,
          name: existing.name || existing.displaySymbol || fallback.name,
          legalName: (existing as { legalName?: string }).legalName || existing.name || existing.displaySymbol || fallback.legalName,
          exchangeMic: existing.exchangeMic || fallback.exchangeMic,
          country: existing.country || fallback.country,
          currency: (existing as { currency?: string }).currency || fallback.currency,
        };
      }
      return fallback;
    };

    if (displayCurrency === "NATIVE") {
      const baseHoldings = calculationMarketFilter === "ALL"
        ? (nativeSummary?.holdings ?? [])
        : (nativeSummary?.holdings ?? []).filter((h) => {
            const sec = resolveSecurity(h.securityId);
            return securityMatchesPortfolioFilter(sec, calculationMarketFilter, h.securityId);
          });
      return baseHoldings.map((holding) => {
        const security = resolveSecurity(holding.securityId);
        const summaryHolding = visibleSummary?.holdings?.find((h) => h.securityId === holding.securityId);
        return {
          ...holding,
          security,
          summaryMarketValue: summaryHolding?.marketValue ?? null,
        };
      });
    }
    return (visibleSummary?.holdings ?? []).map((holding) => ({
      ...holding,
      security: resolveSecurity(holding.securityId),
      summaryMarketValue: holding.marketValue,
    }));
  }, [calculationMarketFilter, displayCurrency, nativeMarketSecurities, nativeSummary?.holdings, rawSecurityMap, securityMap, seed.securities, visibleSummary?.holdings]);

  const holdings = displayHoldings;

  const intradayBySecurity = useMemo(() => {
    const canonicalMap = new Map<string, Map<string, IntradayBar>>();
    for (const bar of intradayBars) {
      if (bar.securityId === FX_SECURITY_ID) continue;
      const canonical = canonicalDomainSecurityId(bar.securityId);
      const sec = rawSecurityMap.get(bar.securityId) ?? rawSecurityMap.get(canonical);
      const nativeCurrency = sec?.currency ?? (sec as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(sec, bar.securityId) ? "USD" : "JPY");
      const targetCurrency = displayCurrency === "NATIVE" ? nativeCurrency : displayCurrency;
      const fxRate = fxAtTimestamp(bar.timestamp) ?? (validUsdJpy(currentUsdJpy) ? currentUsdJpy : undefined);
      const price = convertAmount(bar.price, nativeCurrency, targetCurrency, fxRate);
      if (price == null) continue;
      let barsByTs = canonicalMap.get(canonical);
      if (!barsByTs) {
        barsByTs = new Map();
        canonicalMap.set(canonical, barsByTs);
      }
      barsByTs.set(bar.timestamp, { ...bar, price: price.toString() });
    }
    const grouped = new Map<string, IntradayBar[]>();
    for (const [canonical, barsByTs] of canonicalMap) {
      const sorted = [...barsByTs.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      for (const id of domainSecurityIdVariants(canonical)) {
        grouped.set(id, sorted);
      }
    }
    return grouped;
  }, [currentUsdJpy, displayCurrency, fxAtTimestamp, intradayBars, rawSecurityMap]);

  const sparklineIntradayBySecurity = useMemo(() => {
    const grouped = new Map<string, IntradayBar[]>();
    const seen = new Set<string>();
    for (const [securityId, bars] of intradayBySecurity) {
      const canonical = canonicalDomainSecurityId(securityId);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      const security = rawSecurityMap.get(canonical) ?? rawSecurityMap.get(securityId);
      const sessionBars = sparkline24HourBars(bars, {
        now: sessionClock ?? Date.now(),
        exchangeMic: security?.exchangeMic,
        timeZone: security?.timezone,
        currency: security?.currency,
        country: security?.country,
      });
      for (const id of domainSecurityIdVariants(canonical)) grouped.set(id, sessionBars);
    }
    return grouped;
  }, [intradayBySecurity, rawSecurityMap, sessionClock]);

  const nativeSparklineBars = useMemo(() => {
    const latest = new Map<string, string>();
    for (const bar of historyBars) {
      if (bar.date > (latest.get(bar.securityId) ?? "")) latest.set(bar.securityId, bar.date);
    }
    const starts = new Map([...latest].map(([id, date]) => [id, new Date(Date.parse(date) - 40 * 86400_000).toISOString().slice(0, 10)]));
    return historyBars.filter((bar) => bar.securityId !== FX_SECURITY_ID && bar.date >= (starts.get(bar.securityId) ?? ""));
  }, [historyBars]);

  const convertedSparklineBars = useMemo(() => {
    if (calculation.renderBars.length) return [];
    return nativeSparklineBars.flatMap((bar) => {
      const sec = rawSecurityMap.get(bar.securityId);
      const nativeCurrency = sec?.currency ?? (sec as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(sec, bar.securityId) ? "USD" : "JPY");
      const rate = fxAtDate(bar.date);
      const close = convertAmount(bar.close, nativeCurrency, effectiveSummaryCurrency, rate);
      const adjustedClose = convertAmount(bar.adjustedClose, nativeCurrency, effectiveSummaryCurrency, rate);
      if (close == null) return [];
      return [{ ...bar, close, ...(adjustedClose != null ? { adjustedClose } : {}) }];
    });
  }, [calculation.renderBars.length, effectiveSummaryCurrency, fxAtDate, nativeSparklineBars, rawSecurityMap]);

  const convertedHistoryBars = useMemo(() => view !== "security"
    ? (calculation.renderBars.length ? calculation.renderBars : convertedSparklineBars)
    : historyBars.filter((bar) => canonicalDomainSecurityId(bar.securityId) === canonicalDomainSecurityId(detailSecurityId)).flatMap((bar) => {
        if (bar.securityId === FX_SECURITY_ID) return [];
        const sec = rawSecurityMap.get(bar.securityId);
        const nativeCurrency = sec?.currency ?? (sec as { nativeCurrency?: string })?.nativeCurrency ?? (isUsSecurity(sec, bar.securityId) ? "USD" : "JPY");
        const rate = fxAtDate(bar.date);
        const close = convertAmount(bar.close, nativeCurrency, effectiveSummaryCurrency, rate);
        const adjustedClose = convertAmount(bar.adjustedClose, nativeCurrency, effectiveSummaryCurrency, rate);
        if (close == null) return [];
        return [{ ...bar, close, ...(adjustedClose != null ? { adjustedClose } : {}) }];
      }),
    [calculation.renderBars, convertedSparklineBars, detailSecurityId, effectiveSummaryCurrency, fxAtDate, historyBars, rawSecurityMap, view]
  );

  const dailyHistoryBySecurity = useMemo(() => {
    const barsToUse = displayCurrency === "NATIVE"
      ? (calculation.nativeRenderBars.length ? calculation.nativeRenderBars : nativeSparklineBars)
      : convertedHistoryBars;
    const canonicalMap = new Map<string, Map<string, MarketBar>>();
    for (const bar of barsToUse) {
      if (bar.securityId === FX_SECURITY_ID) continue;
      const canonical = canonicalDomainSecurityId(bar.securityId);
      let barsByDate = canonicalMap.get(canonical);
      if (!barsByDate) {
        barsByDate = new Map();
        canonicalMap.set(canonical, barsByDate);
      }
      barsByDate.set(bar.date, bar);
    }
    const grouped = new Map<string, MarketBar[]>();
    for (const [canonical, barsByDate] of canonicalMap) {
      const sorted = [...barsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      for (const id of domainSecurityIdVariants(canonical)) {
        grouped.set(id, sorted);
      }
    }
    return grouped;
  }, [convertedHistoryBars, displayCurrency, calculation.nativeRenderBars, nativeSparklineBars]);

  const nativeIntradayBySecurity = useMemo(() => {
    const canonicalMap = new Map<string, Map<string, IntradayBar>>();
    for (const bar of intradayBars) {
      if (bar.securityId === FX_SECURITY_ID) continue;
      const canonical = canonicalDomainSecurityId(bar.securityId);
      let barsByTs = canonicalMap.get(canonical);
      if (!barsByTs) {
        barsByTs = new Map();
        canonicalMap.set(canonical, barsByTs);
      }
      barsByTs.set(bar.timestamp, bar);
    }
    const grouped = new Map<string, IntradayBar[]>();
    for (const [canonical, barsByTs] of canonicalMap) {
      const security = rawSecurityMap.get(canonical);
      const sorted = sparkline24HourBars(
        [...barsByTs.values()],
        {
          now: sessionClock ?? Date.now(),
          exchangeMic: security?.exchangeMic,
          timeZone: security?.timezone,
          currency: security?.currency,
          country: security?.country,
        },
      );
      for (const id of domainSecurityIdVariants(canonical)) {
        grouped.set(id, sorted);
      }
    }
    return grouped;
  }, [intradayBars, rawSecurityMap, sessionClock]);

  const nativeDailyHistoryBySecurity = useMemo(() => {
    if (displayCurrency === "NATIVE") return dailyHistoryBySecurity;
    const barsToUse = calculation.nativeRenderBars.length ? calculation.nativeRenderBars : nativeSparklineBars;
    const canonicalMap = new Map<string, Map<string, MarketBar>>();
    for (const bar of barsToUse) {
      if (bar.securityId === FX_SECURITY_ID) continue;
      const canonical = canonicalDomainSecurityId(bar.securityId);
      let barsByDate = canonicalMap.get(canonical);
      if (!barsByDate) {
        barsByDate = new Map();
        canonicalMap.set(canonical, barsByDate);
      }
      barsByDate.set(bar.date, bar);
    }
    const grouped = new Map<string, MarketBar[]>();
    for (const [canonical, barsByDate] of canonicalMap) {
      const sorted = [...barsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      for (const id of domainSecurityIdVariants(canonical)) {
        grouped.set(id, sorted);
      }
    }
    return grouped;
  }, [dailyHistoryBySecurity, displayCurrency, calculation.nativeRenderBars, nativeSparklineBars]);

  const intradayHistory = useMemo(() => {
    const changesByTimestamp = new Map<string, Array<{ securityId: string; price: string }>>();
    const holdingValues = new Map<string, Decimal>();
    let portfolioValue = new Decimal(0);
    for (const holding of holdings) {
      const quote = (holding.security as { quote?: MarketQuote | RemoteQuote } | undefined)?.quote;
      const securityBars = intradayBySecurity.get(holding.securityId) ?? [];
      const startingPrice = String(securityBars.length ? securityBars[0].price : holding.currentPrice ?? quote?.previousRegularClose ?? "0");
      const unit = securityPriceUnit(holding.security);
      const openingHoldingValue = new Decimal(holding.quantity).mul(startingPrice).div(unit);
      holdingValues.set(holding.securityId, openingHoldingValue);
      portfolioValue = portfolioValue.plus(openingHoldingValue);
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
    const cumulativeDividends = new Decimal(summaryDividendSummary.totalIncome);
    const points = [{ date: openingTime.toISOString(), value: portfolioValue.toNumber(), dividendAdjustedValue: portfolioValue.plus(cumulativeDividends).toNumber(), capital: Number(activeSummary.costBasis) }];
    for (const timestamp of timestamps) {
      for (const change of changesByTimestamp.get(timestamp) ?? []) {
        const holding = holdingBySecurity.get(change.securityId);
        if (!holding) continue;
        const nextHoldingValue = new Decimal(holding.quantity).mul(change.price).div(securityPriceUnit(holding.security));
        portfolioValue = portfolioValue.minus(holdingValues.get(change.securityId) ?? 0).plus(nextHoldingValue);
        holdingValues.set(change.securityId, nextHoldingValue);
      }
      points.push({ date: timestamp, value: portfolioValue.toNumber(), dividendAdjustedValue: portfolioValue.plus(cumulativeDividends).toNumber(), capital: Number(activeSummary.netDeposits) });
    }
    return sanitizeDatedPoints(points, "value");
  }, [activeSummary.costBasis, activeSummary.netDeposits, summaryDividendSummary.totalIncome, holdings, intradayBySecurity]);

  const portfolioHistoryByRange = useMemo(() => {
    const all = reconstructedHistory.map((point) => ({ date: point.date, value: Number(point.totalValue), dividendAdjustedValue: Number(point.dividendAdjustedValue), capital: Number(point.investedCapital) }));
    const latestDate = all.at(-1)?.date.slice(0, 10) ?? todayKey;
    const filtered = (rangeKey: "1W" | "1M" | "3M" | "YTD") => {
      const cutoff = new Date(`${latestDate}T00:00:00Z`);
      if (rangeKey === "1W") cutoff.setUTCDate(cutoff.getUTCDate() - 7);
      if (rangeKey === "1M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
      if (rangeKey === "3M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
      if (rangeKey === "YTD") cutoff.setUTCMonth(0, 1);
      const cutoffKey = cutoff.toISOString().slice(0, 10);
      return all.filter((point) => point.date.slice(0, 10) >= cutoffKey);
    };
    return new Map<RangeKey, typeof all>([
      ["ALL", all],
      ["1W", filtered("1W")],
      ["1M", filtered("1M")],
      ["3M", filtered("3M")],
      ["YTD", filtered("YTD")],
    ]);
  }, [reconstructedHistory, todayKey]);
  const history = useMemo(() => {
    if (range === "1D") return trailingHours(intradayHistory, 24);
    if (range === "1W" && intradayHistory.length > 5) {
      const cutoff = new Date(intradayHistory.at(-1)!.date).getTime() - 7 * 24 * 60 * 60_000;
      return intradayHistory.filter((point) => new Date(point.date).getTime() >= cutoff);
    }
    const all = portfolioHistoryByRange.get("ALL") ?? [];
    if (range === "CUSTOM" && customRange) return all.filter((point) => {
      const date = point.date.slice(0, 10);
      return date >= customRange.from && date <= customRange.to;
    });
    return portfolioHistoryByRange.get(range) ?? all;
  }, [customRange, intradayHistory, portfolioHistoryByRange, range]);
  const verifiedPortfolioHistory = fxConversionReady && marketReconciliation.valid ? history : [];

  const portfolioDateBounds = useMemo(() => ({
    min: reconstructedHistory[0]?.date.slice(0, 10) ?? summaryVisibleTransactions.map((transaction) => transaction.tradeDate.slice(0, 10)).sort()[0] ?? todayKey,
    max: reconstructedHistory.at(-1)?.date.slice(0, 10) ?? todayKey,
  }), [reconstructedHistory, todayKey, summaryVisibleTransactions]);

  const latestQuoteAt = Object.values(quotes).map((quote) => quote.fetchedAt).sort().at(-1) ?? null;
  const marketSessions = useMemo(() => {
    const local = sessionClock == null ? [] : portfolioMarketSessions("ALL", new Date(sessionClock));
    return selectReliableMarketSessions("ALL", local, serverMarketSessions);
  }, [serverMarketSessions, sessionClock]);
  const selectedHolding = useMemo(() => {
    if (!detailSecurityId) return undefined;
    const current = holdings.find((holding) => holding.securityId === detailSecurityId);
    if (current) return current;
    const security =
      securityMap.get(detailSecurityId) ??
      rawSecurityMap.get(detailSecurityId) ??
      allSecurities.find((item) => item.id === detailSecurityId) ??
      customSecurities.find((item) => item.id === detailSecurityId) ??
      watchlist.find((item) => item.id === detailSecurityId) ??
      (seed.securities as SearchSecurity[]).find((item) => item.id === detailSecurityId);
    if (!security) return undefined;
    const detailTransactions = (displayCurrency === "NATIVE" ? calculationTransactions : allConvertedTransactions).filter((transaction) => transaction.securityId === detailSecurityId);
    const rawSecurity = rawSecurityMap.get(detailSecurityId) ?? security;
    const nativeCurrency = rawSecurity.currency ?? (security as { nativeCurrency?: string }).nativeCurrency ?? (isUsSecurity(security, detailSecurityId) ? "USD" : "JPY");
    const targetCurrency = displayCurrency === "NATIVE" ? nativeCurrency : displayCurrency;
    const convertedSecurity = securityMap.get(detailSecurityId);
    const detailReceipts = (displayCurrency === "NATIVE" ? allNativeDividendSummary.receipts : allConvertedDividendReceipts).filter((receipt) => matchSecurityId(receipt.securityId, detailSecurityId));
    const result = calculateAverageCostPortfolio(detailTransactions, [displayCurrency === "NATIVE" ? rawSecurity : (convertedSecurity ?? security)], applicableCorporateActions, [], todayKey, detailReceipts);
    const quote = resolveQuoteFromRecord(quotes, detailSecurityId) ?? (security as { quote?: RemoteQuote }).quote;
    const currentPrice = displayCurrency === "NATIVE" ? (quote?.price ?? null) : (convertedSecurity?.quote?.price ?? (quote?.price != null ? convertAmount(quote.price, nativeCurrency, targetCurrency, currentUsdJpy) : null) ?? null);
    const previousClose = displayCurrency === "NATIVE" ? (quote?.previousRegularClose ?? null) : (convertedSecurity?.quote?.previousRegularClose ?? (quote?.previousRegularClose != null ? convertAmount(quote.previousRegularClose, nativeCurrency, targetCurrency, previousUsdJpy) : null) ?? null);
    const dayDiff = currentPrice != null && previousClose != null ? new Decimal(currentPrice).minus(previousClose).toString() : null;
    return {
      securityId: detailSecurityId,
      quantity: "0",
      totalCost: "0",
      averageCost: "0",
      currentPrice,
      marketValue: "0",
      unrealizedGain: "0",
      distributionIncome: result.distributionIncome ?? "0",
      realizedGain: result.realizedGain ?? "0",
      dayGain: dayDiff ?? "0",
      security: {
        ...security,
        currency: targetCurrency,
        nativeCurrency,
        quote: convertedSecurity?.quote ?? (quote && currentPrice != null ? {
          ...quote,
          price: currentPrice,
          ...(previousClose != null ? { previousRegularClose: previousClose } : {}),
        } : undefined),
      },
    };
  }, [allConvertedTransactions, allNativeDividendSummary.receipts, allSecurities, applicableCorporateActions, calculationTransactions, allConvertedDividendReceipts, currentUsdJpy, customSecurities, detailSecurityId, displayCurrency, holdings, previousUsdJpy, quotes, rawSecurityMap, securityMap, seed.securities, todayKey, watchlist]);
  const selectedTradeSecurity = rawSecurityMap.get(selectedSecurity);
  const pendingSplitActions = useMemo(() => {
    if (!hydrated) return [];
    const acknowledged = new Set(acknowledgedActionIds);
    const earliestTradeBySecurity = new Map<string, string>();
    for (const transaction of transactions) {
      if (!transaction.securityId) continue;
      const date = transaction.tradeDate.slice(0, 10);
      const current = earliestTradeBySecurity.get(transaction.securityId);
      if (!current || date < current) earliestTradeBySecurity.set(transaction.securityId, date);
    }
    return applicableCorporateActions.filter((action) => {
      const firstTrade = earliestTradeBySecurity.get(action.securityId);
      return !acknowledged.has(action.id) && Boolean(firstTrade && firstTrade <= action.effectiveDate.slice(0, 10));
    }).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  }, [acknowledgedActionIds, applicableCorporateActions, hydrated, transactions]);
  const acknowledgeSplits = useCallback(() => {
    setAcknowledgedActionIds((current) => {
      const next = [...new Set([...current, ...pendingSplitActions.map((action) => action.id)])];
        preferenceStorage.setItem("kabutora-acknowledged-actions-v1", JSON.stringify(next.slice(-1000)));
      return next;
    });
  }, [allowPersistentMarketCache, pendingSplitActions]);

  const markNotificationRead = useCallback((notificationId: string) => {
    if (!notificationId) return;
    setReadNotificationIds((current) => {
      if (current.includes(notificationId)) return current;
      const next = [...current, notificationId];
        preferenceStorage.setItem("kabutora-read-notifications-v1", JSON.stringify(next));
      return next;
    });
  }, [allowPersistentMarketCache]);

  const markNotificationsRead = useCallback((notificationIds: string[]) => {
    if (!notificationIds || !notificationIds.length) return;
    setReadNotificationIds((current) => {
      const currentSet = new Set(current);
      const toAdd = notificationIds.filter((id) => Boolean(id) && !currentSet.has(id));
      if (toAdd.length === 0) return current;
      const next = [...current, ...toAdd];
        preferenceStorage.setItem("kabutora-read-notifications-v1", JSON.stringify(next));
      return next;
    });
  }, [allowPersistentMarketCache]);
  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }, []);

  const requestTransactionDelete = useCallback((transactionId: string) => {
    const transaction = transactions.find((item) => item.id === transactionId);
    if (transaction) setPendingDeleteTransaction(transaction);
  }, [transactions]);

  const closeTradeModal = useCallback(() => {
    setTradeOpen(false);
    setEditingTransaction(null);
    setTradeSearchActive(false);
    setCustomBroker("");
  }, []);

  const openNewTrade = useCallback(() => {
    setEditingTransaction(null);
    setTradeType("BUY");
    setTradeDate(localDateInputValue());
    setTradeQuantity("");
    setTradePrice("");
    setTradeSearchActive(false);
    setCustomBroker("");
    setTradeOpen(true);
  }, []);

  const requestTransactionEdit = useCallback((transactionId: string) => {
    const transaction = transactions.find((item) => item.id === transactionId);
    if (!transaction || !transaction.securityId || (transaction.type !== "BUY" && transaction.type !== "SELL")) return;
    setEditingTransaction(transaction);
    setTradeType(transaction.type);
    setTradeDate(transaction.tradeDate.slice(0, 10));
    setTradeQuantity(String(transaction.quantity ?? "").replace(/^-/, ""));
    setTradePrice(String(transaction.pricePerShare ?? "").replace(/^-/, ""));
    setSelectedSecurity(transaction.securityId);
    setSelectedAccountId(transaction.accountId);
    setTradeSearchActive(false);
    setCustomBroker("");
    setTradeOpen(true);
  }, [transactions]);

  const confirmTransactionDelete = () => {
    if (!pendingDeleteTransaction) return;
    const deleted = pendingDeleteTransaction;
    const next = transactions.filter((transaction) => transaction.id !== deleted.id);
    setTransactions(next);
    setPendingDeleteTransaction(null);
    if (view === "security" && deleted.securityId === detailSecurityId && !next.some((transaction) => transaction.securityId === detailSecurityId)) navigateToView("overview");
    void onTransactionsChange?.(next);
    showToast("取引を削除し、損益を再計算しました");
  };

  const confirmAccountRemoval = () => {
    if (!pendingRemoveAccountId) return;
    const target = accountMap.get(pendingRemoveAccountId);
    if (!target) return setPendingRemoveAccountId(null);
    const now = new Date().toISOString();
    const next = accounts.map((account) => account.id === target.id ? {
      ...account,
      archivedAt: now,
      updatedAt: now,
      version: Number(account.version ?? 1) + 1,
    } : account);
    const nextSelection = next.find((account) => !account.archivedAt && account.broker !== "現金口座")?.id
      ?? next.find((account) => !account.archivedAt)?.id
      ?? "__custom__";
    setAccounts(next);
    setSelectedAccountId(nextSelection);
    setPendingRemoveAccountId(null);
    void onAccountsChange?.(next);
    showToast(`${target.name}を取引口座一覧から削除しました`);
  };

  const refreshMarket = useCallback((force: boolean | unknown = false) => {
    if (manualRefreshInFlight.current) return manualRefreshInFlight.current;
    const now = Date.now();
    const isForced = force === true || (typeof force === "object" && force !== null);
    if (!isForced && now - lastManualRefreshAt.current < 30_000) {
      showToast("直前の更新結果を使用中");
      return Promise.resolve();
    }
    lastManualRefreshAt.current = now;
    setIsManualRefreshing(true);
    setMarketError("");
    setHistoryError("");

    const marketTask = persistenceMode === "cloud" ? refreshQueuedMarketData(
      splitSecurityIds(quoteSecurityIds, Number.MAX_SAFE_INTEGER).flat(),
      { allowPersistentCache: allowPersistentMarketCache, onSnapshot: applyServerMarketSnapshot },
    ) : Promise.all([
      loadQuotes(isForced, isForced ? "full" : "incremental"),
      loadBenchmarks(isForced),
      loadDistributions(isForced),
    ]);
    if (persistenceMode === "cloud") {
      // Chart/dividend recovery must not hold up or determine the price-refresh result.
      void refreshServerUsIntraday(true).catch(() => undefined);
      void loadDistributions(false).catch(() => undefined);
      void loadHistory(false).catch(() => undefined);
    }
    const refreshTask = (persistenceMode !== "cloud" && ["overview", "watchlist", "performance", "security", "notifications"].includes(activeViewRef.current)
      ? marketTask.then(() => loadHistory(isForced))
      : marketTask)
      .then((result) => {
        showToast(result === "pending" ? "市場データを更新中です。取得できた価格から反映します"
          : result === "partial" ? "一部の市場データを取得できませんでした。保存済み価格を表示しています"
          : result === "limited" ? "本日の無料枠に達しました。最新の保存済み価格を表示しています"
          : result === "cached" ? "直前の更新結果を使用中" : "市場データを更新しました");
      })
      .catch((err) => {
        showToast("更新に失敗しました");
        console.error(err);
      })
      .finally(() => {
        manualRefreshInFlight.current = null;
        setIsManualRefreshing(false);
      });
    manualRefreshInFlight.current = refreshTask;
    return refreshTask;
  }, [allowPersistentMarketCache, applyServerMarketSnapshot, loadBenchmarks, loadDistributions, loadHistory, loadQuotes, persistenceMode, quoteSecurityIds, refreshServerUsIntraday, showToast]);


  const openSecurity = useCallback((securityOrId: string | SearchSecurity, origin?: View) => {
    const isObject = typeof securityOrId === "object" && securityOrId !== null;
    const id = isObject ? securityOrId.id : securityOrId;
    if (isObject) {
      setCustomSecurities((prev) => {
        if (prev.some((item) => item.id === id)) return prev;
        return [...prev, securityOrId];
      });
    }
    const returnTarget = origin ?? (activeViewRef.current !== "security" ? activeViewRef.current : detailReturnViewRef.current);
    detailReturnViewRef.current = returnTarget;
    setDetailReturnView(returnTarget);
    setDetailSecurityId(id);
    navigateToView("security", false);
  }, [navigateToView]);

  const closeSecurity = useCallback(() => {
    const target = detailReturnViewRef.current === "security" ? "overview" : detailReturnViewRef.current;
    navigateToView(target);
  }, [navigateToView]);

  const openNotificationSecurity = useCallback((securityId: string) => {
    setSummaryBrokerFilter("ALL");
    setSummaryMarketFilter("ALL");
    openSecurity(securityId, "notifications");
  }, [openSecurity]);

  const openOverviewSecurity = useCallback((securityId: string) => {
    openSecurity(securityId, "overview");
  }, [openSecurity]);

  const openDividendSecurity = useCallback((securityId: string) => {
    openSecurity(securityId, "dividends");
  }, [openSecurity]);

  const openWatchlistSecurity = useCallback((security: SearchSecurity | string) => {
    openSecurity(security, "watchlist");
  }, [openSecurity]);

  const handleAddWatchlist = useCallback((security: SearchSecurity) => {
    setWatchlist((current) => {
      if (current.some((item) => item.id === security.id)) return current;
      const next = [...current, security];
      void onWatchlistChange?.(next);
      return next;
    });
    if (!allSecurities.some((item) => item.id === security.id)) {
      const next = [...customSecurities, security];
      setCustomSecurities(next);
      void onSecuritiesChange?.([...seed.securities, ...next]);
    }
    setQuoteRefreshToken((current) => current + 1);
  }, [allSecurities, customSecurities, onSecuritiesChange, onWatchlistChange, seed.securities]);

  const handleRemoveWatchlist = useCallback((securityId: string) => {
    setWatchlist((current) => {
      const next = current.filter((item) => item.id !== securityId);
      void onWatchlistChange?.(next);
      return next;
    });
  }, [onWatchlistChange]);

  const selectTradeSecurity = useCallback((security: SearchSecurity) => {
    if (!allSecurities.some((item) => item.id === security.id)) {
      const next = [...customSecurities, security];
      setCustomSecurities(next);
      void onSecuritiesChange?.([...seed.securities, ...next]);
    }
    setSelectedSecurity(security.id);
    const selectedAccount = activeAccounts.find((account) => account.id === selectedAccountId);
    if (selectedAccount?.defaultCurrency && selectedAccount.defaultCurrency !== security.currency) {
      const matchingAccount = activeAccounts.find((account) => account.defaultCurrency === security.currency && account.broker !== "現金口座");
      if (matchingAccount) setSelectedAccountId(matchingAccount.id);
    }
  }, [activeAccounts, allSecurities, customSecurities, onSecuritiesChange, seed.securities, selectedAccountId]);

  const handleOpenTradeForSecurity = useCallback((security: SearchSecurity) => {
    selectTradeSecurity(security);
    setTradeOpen(true);
  }, [selectTradeSecurity]);

  const handleSearchNetworkRequest = useCallback(() => {
    setApiUsage((current) => ({ ...current, searchRequests: current.searchRequests + 1, lastSearchRequest: new Date().toISOString() }));
  }, []);

  const touchNavigationOrder = () => window.matchMedia(MOBILE_LAYOUT_QUERY).matches
    ? MOBILE_TOUCH_NAVIGATION_ORDER
    : DESKTOP_TOUCH_NAVIGATION_ORDER;

  const navigationTargetForDelta = (deltaX: number) => {
    if (activeViewRef.current === "security") return deltaX > 0 ? detailReturnViewRef.current : null;
    return adjacentTouchView(activeViewRef.current, deltaX, touchNavigationOrder());
  };

  const handleTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    const target = event.target;
    const compact = window.matchMedia(MOBILE_LAYOUT_QUERY).matches;
    const isInteractiveInput = isInteractiveInputTarget(target);
    const currentScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    if (
      event.touches.length !== 1
      || !touch
      || isInteractiveInput
      || (!compact && currentScrollY > 0)
    ) {
      touchGesture.current = null;
      return;
    }
    const now = performance.now();
    touchGesture.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastAt: now,
      velocityX: 0,
      distanceX: 0,
      axis: "pending",
      currentIndex: MOBILE_VIEW_INDEX[renderedView] ?? 2,
      pullEnabled: renderedView !== "security" && !isPullRefreshing && currentScrollY <= 2,
      swipeBlocked: isSwipeBlockedTarget(target),
    };
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    const gesture = touchGesture.current;
    const touch = event.touches[0];
    if (!gesture || !touch || event.touches.length !== 1) return;
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;

    if (gesture.axis === "pending") {
      const axis = resolveTouchAxis(deltaX, deltaY, TOUCH_NAVIGATION_LOCK_PX);
      if (axis === "horizontal") {
        gesture.axis = gesture.swipeBlocked ? "cancelled" : "horizontal";
      } else if (axis === "vertical") {
        gesture.axis = gesture.pullEnabled && deltaY > 0 ? "vertical" : "cancelled";
      }
    }
    if (gesture.axis === "cancelled" || gesture.axis === "pending") return;

    if (gesture.axis === "horizontal") {
      if (event.cancelable) event.preventDefault();
      const now = performance.now();
      const elapsed = Math.max(1, now - gesture.lastAt);
      const instantaneousVelocity = (touch.clientX - gesture.lastX) / elapsed;
      gesture.velocityX = gesture.velocityX * 0.55 + instantaneousVelocity * 0.45;
      gesture.lastX = touch.clientX;
      gesture.lastAt = now;
      gesture.distanceX = deltaX;
      return;
    }

    const currentScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    if (currentScrollY > 2) {
      gesture.axis = "cancelled";
      pullDistanceRef.current = 0;
      updatePullVisuals(0, false, false);
      return;
    }

    if (deltaY > 0) {
      if (event.cancelable) event.preventDefault();
      const nextDistance = Math.min(PULL_REFRESH_MAX, Math.pow(deltaY, 0.82) * 1.6);
      pullDistanceRef.current = nextDistance;
      updatePullVisuals(nextDistance, false, false);
    } else {
      pullDistanceRef.current = 0;
      updatePullVisuals(0, false, false);
    }
  };

  const finishTouchGesture = (cancelled: boolean) => {
    const gesture = touchGesture.current;
    const shouldRefresh = gesture?.axis === "vertical" && pullDistanceRef.current >= PULL_REFRESH_THRESHOLD;
    const releaseVelocity = gesture && performance.now() - gesture.lastAt <= 90 ? gesture.velocityX : 0;

    if (gesture?.axis === "horizontal") {
      if (renderedView === "security") {
        const shouldClose = !cancelled && gesture.distanceX > 0 && (
          gesture.distanceX >= 45 || (gesture.distanceX >= 20 && Math.abs(releaseVelocity) >= 0.3)
        );
        if (shouldClose) {
          closeSecurity();
        }
        touchGesture.current = null;
        pullDistanceRef.current = 0;
        return;
      }
      const idx = gesture.currentIndex;
      const direction = gesture.distanceX < 0 ? 1 : -1;
      const canNavigate = (direction === 1 && idx < MOBILE_TOUCH_NAVIGATION_ORDER.length - 1) || (direction === -1 && idx > 0);
      const shouldNavigate = !cancelled && canNavigate && shouldCommitSwipe(
        Math.abs(gesture.distanceX),
        Math.abs(releaseVelocity),
        window.innerWidth,
        true,
      );

      if (shouldNavigate) {
        const nextIndex = idx + direction;
        const nextView = MOBILE_TOUCH_NAVIGATION_ORDER[nextIndex];
        if (nextView) {
          navigateToView(nextView);
        }
      }
    }

    touchGesture.current = null;
    pullDistanceRef.current = 0;

    if (!cancelled && shouldRefresh) {
      updatePullVisuals(0, true, true);
      setIsPullRefreshing(true);
      void refreshMarket(true).finally(() => {
        setIsPullRefreshing(false);
        updatePullVisuals(0, false, true);
      });
    } else {
      updatePullVisuals(0, false, true);
    }
  };

  const handleTouchEnd = () => finishTouchGesture(false);
  const handleTouchCancel = () => finishTouchGesture(true);

  useEffect(() => {
    let wheelAccumulator = 0;
    let wheelDecayTimer: ReturnType<typeof setTimeout> | null = null;

    const handleWheel = (event: WheelEvent) => {
      if (window.scrollY > 0 || isManualRefreshing || isPullRefreshing || renderedView === "security") return;
      if (event.deltaY < 0 && !event.ctrlKey) {
        wheelAccumulator += Math.abs(event.deltaY) * 0.45;
        const clamped = Math.min(PULL_REFRESH_MAX, wheelAccumulator);
        if (clamped > 3) {
          pullDistanceRef.current = clamped;
          updatePullVisuals(clamped, false, false);
        }

        if (wheelDecayTimer) clearTimeout(wheelDecayTimer);
        wheelDecayTimer = setTimeout(() => {
          if (pullDistanceRef.current >= PULL_REFRESH_THRESHOLD) {
            pullDistanceRef.current = 0;
            updatePullVisuals(0, true, true);
            setIsPullRefreshing(true);
            void refreshMarket(true).finally(() => {
              setIsPullRefreshing(false);
              updatePullVisuals(0, false, true);
            });
          } else {
            pullDistanceRef.current = 0;
            updatePullVisuals(0, false, true);
          }
          wheelAccumulator = 0;
        }, 140);
      }
    };

    window.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      window.removeEventListener("wheel", handleWheel);
      if (wheelDecayTimer) clearTimeout(wheelDecayTimer);
    };
  }, [isManualRefreshing, isPullRefreshing, refreshMarket, renderedView, updatePullVisuals]);

  useLayoutEffect(() => {
    if (!hydrated || !marketStartupReady) return;
    const savedScrollTop = viewScrollPositionsRef.current[renderedView] ?? 0;
    window.scrollTo({ top: savedScrollTop, behavior: "auto" });
  }, [hydrated, marketStartupReady, renderedView]);

  const parsedTradeQuantity = parseDecimalInput(tradeQuantity);
  const parsedTradePrice = parseDecimalInput(tradePrice);
  const validTradeAmounts = Boolean(parsedTradeQuantity?.gt(0) && parsedTradePrice?.gte(0));
  const tradePreview = validTradeAmounts ? parsedTradeQuantity!.mul(parsedTradePrice!).div(securityPriceUnit(selectedTradeSecurity)) : null;

  const submitTrade = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validTradeAmounts || !parsedTradeQuantity || !parsedTradePrice || !tradePreview || !Number.isFinite(tradePreview.toNumber())) return;
    const security = rawSecurityMap.get(selectedSecurity);
    if (!security) return;
    let account = selectableAccounts.find((item) => item.id === selectedAccountId);
    if (selectedAccountId === "__custom__") {
      const broker = customBroker.trim();
      if (!broker) return;
      account = activeAccounts.find((item) => item.broker.toLocaleLowerCase("ja") === broker.toLocaleLowerCase("ja"));
      if (!account) {
        account = { id: `account-${crypto.randomUUID()}`, name: `${broker} ${security.currency === "USD" ? "米国株" : "特定"}`, broker, accountType: "taxable", country: security.currency === "USD" ? "US" : "JP", defaultCurrency: security.currency };
        const nextAccounts = [...accounts, account];
        setAccounts(nextAccounts);
        setSelectedAccountId(account.id);
        void onAccountsChange?.(nextAccounts);
      }
    }
    if (!account) return;
    const amount = parsedTradeQuantity.mul(parsedTradePrice).div(securityPriceUnit(security)).toString();
    const now = new Date().toISOString();
    const recordedTradeDate = tradeDate || now.slice(0, 10);
    const transaction = editingTransaction ? {
      ...editingTransaction,
      accountId: account.id, securityId: security.id, type: tradeType, tradeDate: recordedTradeDate,
      quantity: parsedTradeQuantity.toString(), pricePerShare: parsedTradePrice.toString(), tradeCurrency: security.currency, grossAmount: amount,
      original: { ...editingTransaction.original, broker: account.broker, nisa: account.accountType === "nisa" ? "Y" : "N", action: tradeType },
      updatedAt: now, version: Number(editingTransaction.version ?? 1) + 1,
    } satisfies Seed["transactions"][number] : {
      id: `trade-${crypto.randomUUID()}`, portfolioId: seed.portfolio.id, accountId: account.id, securityId: security.id,
      type: tradeType, tradeDate: recordedTradeDate, quantity: parsedTradeQuantity.toString(), pricePerShare: parsedTradePrice.toString(), tradeCurrency: security.currency,
      grossAmount: amount, source: "manual", original: { broker: account.broker, nisa: account.accountType === "nisa" ? "Y" : "N", action: tradeType, row: 0 },
      createdAt: now, updatedAt: now, version: 1,
    } satisfies Seed["transactions"][number];
    const next = editingTransaction ? transactions.map((item) => item.id === editingTransaction.id ? transaction : item) : [...transactions, transaction];
    setTransactions(next);
    if (editingTransaction && view === "security" && editingTransaction.securityId === detailSecurityId && security.id !== detailSecurityId && !next.some((item) => item.securityId === detailSecurityId)) navigateToView("overview");
    const coveredFrom = earliestHistoryDate(historyBars, security.id);
    if (!coveredFrom || recordedTradeDate < coveredFrom) setHistoryRequested(false);
    void onTransactionsChange?.(next);
    const edited = Boolean(editingTransaction);
    closeTradeModal();
    setTradeQuantity("");
    setTradePrice("");
    setTradeDate(localDateInputValue());
    showToast(`${security.displaySymbol} ${tradeType === "BUY" ? "買付" : "売却"}を${edited ? "更新" : "保存"}`);
  };

  const exportCsv = useCallback(() => {
    const header = ["schema_version", "transaction_id", "account_id", "symbol", "exchange_mic", "type", "trade_datetime", "quantity", "price_per_share", "trade_currency", "gross_amount", "source"];
    const rows = transactions.map((transaction) => {
      const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : undefined;
      return [1, transaction.id, transaction.accountId, security?.displaySymbol ?? "", security?.exchangeMic ?? "", transaction.type, transaction.tradeDate, transaction.quantity, transaction.pricePerShare, transaction.tradeCurrency, transaction.grossAmount, transaction.source];
    });
    download("kabutora-transactions.csv", `\uFEFF${[header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n")}`, "text/csv;charset=utf-8");
    showToast("CSVを書き出しました");
  }, [rawSecurityMap, showToast, transactions]);

  const exportJson = useCallback(() => {
    download("kabutora-backup.json", JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      portfolio: seed.portfolio,
      accounts,
      securities: allSecurities,
      transactions,
      watchlist,
      preferences: currentPreferences,
    }, null, 2), "application/json");
    showToast("バックアップを書き出しました");
  }, [accounts, allSecurities, currentPreferences, seed.portfolio, showToast, transactions, watchlist]);
  const settingsSeed = useMemo<Seed>(() => ({
    ...seed,
    accounts,
    securities: allSecurities,
    transactions,
    watchlist,
    preferences: currentPreferences,
  }), [accounts, allSecurities, currentPreferences, seed, transactions, watchlist]);
  const markAllNotificationsRead = useCallback((targetIds?: string[]) => {
    const ids = Array.isArray(targetIds) && targetIds.length > 0
      ? targetIds
      : portfolioNotifications.map((notice) => notice.id);
    markNotificationsRead(ids);
  }, [markNotificationsRead, portfolioNotifications]);

  useLayoutEffect(() => {
    if (!hydrated || !marketStartupReady) return;
    onStartupReady?.();
    const frame = window.requestAnimationFrame(() => setStartupCoverExiting(true));
    const timer = window.setTimeout(() => setStartupCoverVisible(false), 220);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [hydrated, marketStartupReady, onStartupReady]);

  useEffect(() => {
    if (!hydrated || !marketStartupReady) return;
    const pending: View[] = ["watchlist", "activity", "dividends", "notifications", "settings"];
    const idleWindow = window as unknown as {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let cancelled = false;
    let timeoutId: number | undefined;
    let idleId: number | undefined;
    const warmNextView = () => {
      if (cancelled) return;
      const nextView = pending.shift();
      if (!nextView) return;
      setMountedViews((current) => {
        if (current.has(nextView)) return current;
        const next = new Set(current);
        next.add(nextView);
        return next;
      });
      scheduleNext();
    };
    const scheduleNext = () => {
      if (cancelled || !pending.length) return;
      if (idleWindow.requestIdleCallback) {
        idleId = idleWindow.requestIdleCallback(warmNextView, { timeout: 1_500 });
      } else {
        timeoutId = window.setTimeout(warmNextView, 600);
      }
    };
    scheduleNext();
    return () => {
      cancelled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
      if (idleId != null) idleWindow.cancelIdleCallback?.(idleId);
    };
  }, [hydrated, marketStartupReady]);

  return <>
    <div
      ref={appShellRef}
      className={`app-shell ${dark ? "theme-dark" : "theme-light"} ${!hydrated ? "app-preload" : ""}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <header className="app-header">
        <Brand />
        <nav className="desktop-nav" aria-label="主要メニュー">
          {NAV_ITEMS.map((item) => {
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={active ? "active" : ""}
                aria-label={item.label}
                onClick={() => navigateToView(item.id)}
              >
                {item.label}
                {item.id === "notifications" && unreadNotificationCount > 0 && (
                  <b className="notification-badge">{Math.min(99, unreadNotificationCount)}</b>
                )}
              </button>
            );
          })}
        </nav>
        <div className="header-actions">
          <span className={`market-health ${quoteStatus}`} title={autoRefresh ? `自動価格更新 ${effectiveUpdateMinutes}分間隔` : "自動価格更新オフ"}><i />{quoteStatus === "loading" ? "取得中" : `${quoteHealth.returned || activeSummary.pricedSecurityCount}/${quoteHealth.requested || activeSummary.pricedSecurityCount + activeSummary.unpricedSecurityCount}`}</span>
          <div className="header-filters" role="group" aria-label="ポートフォリオ表示フィルター">
            <label className="broker-filter" title="証券会社で保有銘柄と取引履歴を絞り込み"><span>証券会社</span><select aria-label="証券会社で絞り込み" value={summaryBrokerFilter} onChange={(event) => handleSummaryBrokerFilterChange(event.target.value)}><option value="ALL">全口座</option>{brokerOptions.map((broker) => <option key={broker} value={broker}>{broker.replace("証券", "")}</option>)}</select></label>
            <label className="market-filter" title="資産区分と個別株の国でポートフォリオを絞り込み"><span>資産区分</span><select aria-label="資産区分と国で絞り込み" value={summaryMarketFilter} onChange={(event) => handleSummaryMarketFilterChange(event.target.value as PortfolioFilter)}><option value="ALL">全資産</option><option value="JP">日本株</option><option value="US">米国株</option><option value="FUNDS_INDEXES">投信・指数</option></select></label>
            <label className="currency-filter" title="表示通貨"><span>表示通貨</span><select aria-label="表示通貨" value={displayCurrency} onChange={(event) => handleDisplayCurrencyChange(event.target.value as DisplayCurrency)}><option value="JPY">JPY</option><option value="USD">USD</option><option value="NATIVE">現地通貨</option></select></label>
          </div>
          <div className="header-tools">
            <button className="icon-button" onClick={() => handleSummaryAmountsVisibleChange((v) => !v)} aria-label={summaryAmountsVisible ? "金額を非表示" : "金額を表示"} title={summaryAmountsVisible ? "金額を非表示" : "金額を表示"}>{summaryAmountsVisible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
            <button className="icon-button" onClick={() => refreshMarket(true)} aria-label="市場データを更新"><RefreshCw size={17} /></button>
            <button className="icon-button" onClick={() => handleDarkChange((value) => !value)} aria-label="テーマを切り替え">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
            <button className="trade-button" aria-label="取引を記録" onClick={openNewTrade}><Plus size={16} /><span>取引</span></button>
          </div>
        </div>
      </header>

      <main
        ref={workspaceRef}
        className="workspace"
        data-calculation-pending={historyCalculationPending}
        data-history-pending={historyCalculatorRef.current?.diagnostics().pending ?? 0}
        data-history-max-pending={historyCalculatorRef.current?.diagnostics().maxPending ?? 0}
        data-history-bar-copies={historyCalculatorRef.current?.diagnostics().barCopies ?? 0}
        data-market-views-preloaded={marketViewsPreloadedRef.current}
        data-navigation-views-preloaded={NAV_ITEMS.every((item) => mountedViews.has(item.id))}
      >
        {completedHistory?.request === historyRequest && completedHistory.failed && <div className="cloud-error" role="status">履歴の計算を完了できませんでした。<button className="text-button" onClick={() => setHistoryAttempt((value) => value + 1)}>計算を再試行</button></div>}
        {mountedViews.has("activity") && <RetainedView active={renderedView === "activity"}>
          <FastActivityView transactions={calculationTransactions} securityMap={rawSecurityMap} accountMap={accountMap} corporateActions={applicableCorporateActions} brokerOptions={brokerOptions} onEdit={requestTransactionEdit} onDelete={requestTransactionDelete} onOpenTrade={openNewTrade} />
        </RetainedView>}
        {mountedViews.has("dividends") && <RetainedView active={renderedView === "dividends"}>
          <FastDividendsView
            receipts={allConvertedDividendReceipts}
            fxUnavailable={dividendFxUnavailable}
            distributions={allRecognizedDistributions}
            nativeDistributions={allRecognizedDistributions}
            coverage={distributionCoverage}
            securityMap={rawSecurityMap}
            accountMap={accountMap}
            currency={effectiveDividendCurrency}
            displayCurrency={dividendDisplayCurrency}
            onDisplayCurrencyChange={handleDividendDisplayCurrencyChange}
            marketFilter={dividendMarketFilter}
            onMarketFilterChange={handleDividendMarketFilterChange}
            period={dividendPeriod}
            onPeriodChange={handleDividendPeriodChange}
            taxMode={dividendTaxMode}
            onTaxModeChange={handleDividendTaxModeChange}
            activeTab={dividendActiveTab}
            onActiveTabChange={handleDividendActiveTabChange}
            distributionStatus={distributionStatus}
            distributionError={distributionError}
            todayKey={todayKey}
            amountsVisible={summaryAmountsVisible}
            onSelectSecurity={openDividendSecurity}
          />

        </RetainedView>}
        {mountedViews.has("overview") && <RetainedView active={renderedView === "overview"}>
          <FastOverview
            totalValue={totalValue} dayGain={dayGain} dayReturn={dayReturn}
            summary={activeSummary} totalGain={totalGain} totalReturn={totalReturn} holdings={holdings} history={verifiedPortfolioHistory} historyStatus={historyStatus}
            quoteStatus={quoteStatus} marketSessions={marketSessions} marketError={marketError} historyError={historyError} dataReconciled={marketReconciliation.valid} benchmarks={benchmarks} benchmarkStatus={benchmarkStatus}
            valuationComplete={valuationComplete} calculationPending={false} fxEstimated={fxEstimated} range={range} setRange={handleRangeChange} intradayBySecurity={sparklineIntradayBySecurity} refreshMarket={refreshMarket}
            dailyHistoryBySecurity={dailyHistoryBySecurity} marketFilter={summaryMarketFilter} setMarketFilter={handleSummaryMarketFilterChange} brokerFilter={summaryBrokerFilter} setBrokerFilter={handleSummaryBrokerFilterChange} brokerOptions={brokerOptions} setDisplayCurrency={handleDisplayCurrencyChange} amountsVisible={summaryAmountsVisible} setAmountsVisible={handleSummaryAmountsVisibleChange}
            customRange={customRange} setCustomRange={handleCustomRangeChange} dateBounds={portfolioDateBounds}
            onSelectSecurity={openOverviewSecurity} currency={displayCurrency} summaryCurrency={effectiveSummaryCurrency} fxReady={fxConversionReady}
            currentTime={sessionClock ?? Date.now()}
          />
        </RetainedView>}
        {mountedViews.has("watchlist") && <RetainedView active={renderedView === "watchlist"}>
          <FastWatchlistView
            watchlist={watchlist}
            onAddSecurity={handleAddWatchlist}
            onRemoveSecurity={handleRemoveWatchlist}
            quotes={quotes}
            intradayBySecurity={nativeIntradayBySecurity}
            dailyHistoryBySecurity={nativeDailyHistoryBySecurity}
            quoteStatus={quoteStatus}
            marketSessions={marketSessions}
            currency="NATIVE"
            currentUsdJpy={validUsdJpy(currentUsdJpy) ? currentUsdJpy : null}
            onSelectSecurity={openWatchlistSecurity}
            onOpenTrade={handleOpenTradeForSecurity}
            onRefresh={refreshMarket}
            amountsVisible={summaryAmountsVisible}
            allSecurities={allSecurities}
            currentTime={sessionClock ?? Date.now()}
          />
        </RetainedView>}
        {mountedViews.has("notifications") && <RetainedView active={renderedView === "notifications"}>
          <FastNotificationsView notifications={portfolioNotifications} securityMap={rawSecurityMap} detailSecurityIds={allTransactionSecurityIds} readNotificationIds={readNotificationIds} onRead={markNotificationRead} onReadAll={markAllNotificationsRead} onOpenSecurity={openNotificationSecurity} monitoredCount={allTransactionSecurityIds.size} quoteStatus={quoteStatus} historyStatus={historyStatus} latestQuoteAt={latestQuoteAt} externalFeedConnected={seededMarketNotices.length > 0} onRefresh={refreshMarket}/>
        </RetainedView>}
        {mountedViews.has("settings") && <RetainedView active={renderedView === "settings"}>
          <FastSettingsView seed={settingsSeed} exportCsv={exportCsv} exportJson={exportJson} onEncryptedBackup={onEncryptedBackup} onRestoreBackup={onRestoreBackup} allowPlaintextExport={allowPlaintextExport} onLock={onLock} onLogout={onLogout} dark={dark} setDark={handleDarkChange} accentTheme={accentTheme} setAccentTheme={handleAccentThemeChange} quoteStatus={quoteStatus} benchmarkStatus={benchmarkStatus} historyStatus={historyStatus} historyQuality={historyQuality} historyCacheMeta={historyCacheMeta} quoteHealth={quoteHealth} historyHealth={historyHealth} dataReconciled={marketReconciliation.valid} corporateActionCount={applicableCorporateActions.length} latestQuoteAt={latestQuoteAt} apiUsage={apiUsage} benchmarkCount={benchmarks.length} quoteCount={Object.keys(quotes).length} intradayCount={intradayBars.length} historyCount={historyBars.length} persistenceMode={persistenceMode} allowPersistentMarketCache={allowPersistentMarketCache} serverOrigin={hydrated ? window.location.origin : "—"} autoRefresh={autoRefresh} setAutoRefresh={handleAutoRefreshChange} updateFrequency={updateFrequency} setUpdateFrequency={handleUpdateFrequencyChange} effectiveUpdateMinutes={effectiveUpdateMinutes} hideScrollbar={hideScrollbar} setHideScrollbar={handleHideScrollbarChange} displayCurrency={displayCurrency} setDisplayCurrency={handleDisplayCurrencyChange} marketFilter={summaryMarketFilter} dividendMarketFilter={dividendMarketFilter} dividendDisplayCurrency={dividendDisplayCurrency} dividendPeriod={dividendPeriod} dividendTaxMode={dividendTaxMode} currentUsdJpy={validUsdJpy(currentUsdJpy) ? currentUsdJpy : null} notificationCount={portfolioNotifications.length} priceAlertThreshold={priceAlertThreshold} setPriceAlertThreshold={handlePriceAlertThresholdChange} />
        </RetainedView>}
        {renderedView === "security" && (
          <div className="view-cache active" style={{ display: "block" }}>
            {selectedHolding ? (
              <SecurityDetailView holding={selectedHolding} transactions={(displayCurrency === "NATIVE" ? calculationTransactions : allConvertedTransactions).filter((transaction) => transaction.securityId === detailSecurityId)} accountMap={accountMap} historyBars={displayCurrency === "NATIVE" ? historyBars : convertedHistoryBars} corporateActions={applicableCorporateActions} historyStatus={historyStatus} onBack={closeSecurity} returnView={detailReturnView} currency={displayCurrency} notifications={portfolioNotifications.filter((notice) => notice.securityId === detailSecurityId)} readNotificationIds={readNotificationIds} onReadNotification={markNotificationRead} onEditTransaction={requestTransactionEdit} onDeleteTransaction={requestTransactionDelete} amountsVisible={summaryAmountsVisible}/>
            ) : (
              <div className="security-detail-page">
                <section className="security-detail-header">
                  <div className="detail-heading">
                    <button type="button" className="detail-back" onClick={closeSecurity} aria-label="戻る"><ArrowLeft size={16}/><span>戻る</span></button>
                  </div>
                </section>
                <div className="empty-state" style={{ padding: "60px 20px" }}>
                  <RefreshCw size={24} className="spin" />
                  <p style={{ marginTop: "12px", color: "var(--muted)" }}>銘柄情報を読み込み中…</p>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <nav className="mobile-nav" aria-label="モバイルナビゲーション" data-swipe-ignore="true">
        {MOBILE_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.id || (view === "security" && item.id === detailReturnView);
          return (
            <button
              key={item.id}
              aria-label={item.shortLabel}
              aria-current={active ? "page" : undefined}
              className={active ? "active" : ""}
              onClick={() => navigateToView(item.id)}
            >
              <span className="mobile-nav-icon">
                <Icon size={25} />
                {item.id === "notifications" && unreadNotificationCount > 0 && (
                  <b className="notification-badge">{Math.min(99, unreadNotificationCount)}</b>
                )}
              </span>
            </button>
          );
        })}
      </nav>

      <TradeModal
        isOpen={tradeOpen}
        editingTransaction={editingTransaction}
        tradeType={tradeType}
        setTradeType={setTradeType}
        nativeMarketSecurities={nativeMarketSecurities}
        selectedTradeSecurity={selectedTradeSecurity}
        selectTradeSecurity={selectTradeSecurity}
        tradeSearchActive={tradeSearchActive}
        setTradeSearchActive={setTradeSearchActive}
        handleSearchNetworkRequest={handleSearchNetworkRequest}
        selectedAccountId={selectedAccountId}
        setSelectedAccountId={setSelectedAccountId}
        selectableAccounts={selectableAccounts}
        accountMap={accountMap}
        customBroker={customBroker}
        setCustomBroker={setCustomBroker}
        tradeDate={tradeDate}
        setTradeDate={setTradeDate}
        tradeQuantity={tradeQuantity}
        setTradeQuantity={setTradeQuantity}
        tradePrice={tradePrice}
        setTradePrice={setTradePrice}
        tradePreview={tradePreview}
        persistenceMode={persistenceMode}
        onSubmit={submitTrade}
        onClose={closeTradeModal}
        onOpenRemoveAccount={setPendingRemoveAccountId}
      />
      <DeleteTransactionDialog
        transaction={pendingDeleteTransaction}
        rawSecurityMap={rawSecurityMap}
        accountMap={accountMap}
        onConfirm={confirmTransactionDelete}
        onCancel={() => setPendingDeleteTransaction(null)}
      />
      <RemoveAccountDialog
        accountId={pendingRemoveAccountId}
        accountMap={accountMap}
        transactions={transactions}
        onConfirm={confirmAccountRemoval}
        onCancel={() => setPendingRemoveAccountId(null)}
      />
      {toast && <div className="toast" role="status">{toast}</div>}
      <UpdatingBanner
        isManualRefreshing={isManualRefreshing}
        quoteStatus={quoteStatus}
        historyStatus={historyStatus}
        distributionStatus={distributionStatus}
        benchmarkStatus={benchmarkStatus}
        historyBarsCount={historyBars.length}
        quotesCount={Object.keys(quotes).length}
      />
    </div>
    {startupCoverVisible && <AppLoadingScreen exiting={startupCoverExiting} label="画面を仕上げています" detail="最新データを表示する準備ができました" />}
  </>;
}
