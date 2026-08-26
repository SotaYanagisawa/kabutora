"use client";

import {
  calculateAverageCostPortfolio,
  deriveSplitAdjustedTransactions,
  deriveTransactionPositionSnapshots,
  reconstructPortfolioHistory,
  reconstructSecurityHistory,
  type CorporateAction,
  type IntradayBar,
  type LedgerTransaction,
  type MarketBar,
  type MarketQuote,
  type PortfolioHistoryPoint,
  type SecurityQuote,
} from "@kabutora/domain";
import corporateActionSeed from "@/data/corporate-actions.json";
import marketNoticeSeed from "@/data/market-notices.json";
import AppLoadingScreen from "@/components/app-loading-screen";
import { getMarketAuthHeaders } from "@/lib/firebase-client";
import { readMarketCache, writeMarketCache } from "@/lib/client-market-cache";
import { mergeIntradayBars } from "@/lib/intraday-cache";
import { quoteRefreshTargets, quoteSessionTransitionTargets } from "@/lib/market-refresh-plan";
import { earliestHistoryDate, inspectMarketHistory, packHistoryBars, unpackHistoryBars, type HistoryQuality, type PackedHistorySeries } from "@/lib/market-history";
import { buildHistoryFetchPlan, historyCoverage, MARKET_REQUEST_BATCH_SIZE, missingHistoryRequirements, splitSecurityIds } from "@/lib/market-fetch-plan";
import { readMarketApiResponse, stableMarketErrorMessage } from "@/lib/market-api-response";
import { searchMarketSecurities } from "@/lib/market-search-client";
import { projectStockPortfolio, reconcilePortfolioParts } from "@/lib/portfolio-consistency";
import { historicalFxRateAtDate } from "@/lib/historical-fx";
import { dynamicChartDomain } from "@/lib/chart-domain";
import { derivePortfolioNotifications, mergePortfolioNotifications, DEFAULT_PRICE_ALERT_PERCENT, PRICE_ALERT_THRESHOLDS, type ExternalMarketNotice, type PortfolioNotification } from "@/lib/portfolio-notifications";
import { portfolioMarketSessions, selectReliableMarketSessions, type MarketSessionStatus } from "@/lib/market-session";
import { resolveMarketClock, trustedMarketClockAnchor, type TrustedMarketClockAnchor } from "@/lib/market-clock";
import { marketDateKey, marketDateTimeLabel, marketTimeLabel, sparseIntradayTimeTicks, trailingHours } from "@/lib/chart-presentation";
import { calendarDateLabelJa, localDateInputValue, shiftCalendarMonths } from "@/lib/calendar-time";
import { compactNumber } from "@/lib/compact-number";
import { companyDisplayName, companyLegalName } from "@/lib/company-name";
import { marketDisplayName } from "@/lib/market-label";
import { searchKnownJapanFunds } from "@/lib/japan-fund-catalog";
import { defaultCurrencyForPortfolioFilter, portfolioFilterLabel, securityMatchesPortfolioFilter, shouldShowDailyFundTrend, type PortfolioFilter } from "@/lib/portfolio-filter";
import { adjacentTouchView, isInteractiveInputTarget, isSwipeBlockedTarget, resolveTouchAxis, shouldCommitNativeSwipe, shouldCommitSwipe } from "@/lib/touch-navigation";
import Decimal from "decimal.js";
import WatchlistView from "@/components/watchlist-view";
import { LightweightAreaChart, LightweightDonutChart } from "@/components/lightweight-charts";
import {
  Activity,
  ArrowLeft,
  AlertTriangle,
  BarChart3,
  Bell,
  Bookmark,
  CalendarDays,
  Check,
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
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type Seed = {
  portfolio: { id: string; name: string; baseCurrency: string; defaultCostBasisMethod: string };
  accounts: Array<{ id: string; name: string; broker: string; accountType: string; country?: string; defaultCurrency?: string; archivedAt?: string; updatedAt?: string; version?: number }>;
  securities: Array<{
    id: string;
    displaySymbol: string;
    name: string;
    brandName?: string;
    shortName?: string;
    longName?: string;
    exchangeMic: string;
    exchangeName?: string;
    exchangeLabel?: string;
    currency: string;
    country?: string;
    timezone?: string;
    assetType?: "stock" | "etf" | "fund" | "index";
    priceUnit?: string;
    providerSymbols: { yahoo?: string; monex?: string };
  }>;
  transactions: Array<LedgerTransaction & {
    portfolioId: string;
    tradeCurrency: string;
    source: string;
    createdAt: string;
    updatedAt: string;
    version: number;
    original: { broker: string | null; nisa: string | null; action: string | null; row: number };
  }>;
  importWarnings: Array<{ row: number; ticker: string; message: string }>;
};

export type RemoteQuote = MarketQuote & { securityId: string; symbol: string; exchangeMic: string; exchangeLabel?: string; currency: string; brandName?: string; brandNameSource?: string; shortName?: string; longName?: string };
export type MarketStatus = "idle" | "loading" | "ready" | "partial" | "error";
type QuoteResponse = {
  generatedAt?: string;
  marketSessions?: MarketSessionStatus[];
  quotes: RemoteQuote[];
  intraday: IntradayBar[];
  failures: Array<{ securityId: string; symbol: string; message: string }>;
  coverage: { requested: number; returned: number; fresh: number; stale: number; suspect: number };
};
type HistoryResponse = {
  generatedAt?: string;
  marketSessions?: MarketSessionStatus[];
  bars: MarketBar[];
  corporateActions: CorporateAction[];
  inceptionDates?: Record<string, string>;
  quality?: HistoryQuality;
  failures: Array<{ securityId: string; symbol: string; message: string }>;
  coverage: { requested: number; returned: number };
};
type Benchmark = {
  id: string;
  label: string;
  symbol: string;
  value: number;
  changeRatio: number | null;
  marketTimestamp: string;
  freshness: MarketQuote["freshness"];
  fetchedAt?: string;
};
type BenchmarkResponse = { generatedAt?: string; marketSessions?: MarketSessionStatus[]; benchmarks: Benchmark[]; failures: Array<{ id: string; message: string }> };
export type SearchSecurity = Seed["securities"][number] & { exchangeLabel?: string };
export type View = "overview" | "watchlist" | "security" | "activity" | "performance" | "notifications" | "settings";
type RangeKey = "1D" | "1W" | "1M" | "3M" | "YTD" | "ALL" | "CUSTOM";
type CustomDateRange = { from: string; to: string };
type SecurityChartMode = "position" | "price";
type UpdateFrequency = 10 | 15 | 30 | 60;
type AccentTheme = "graphite" | "blue" | "forest" | "plum";
export type DisplayCurrency = "JPY" | "USD" | "NATIVE";
type HistoryCacheMeta = { savedAt: string; checksum: string; integrityMismatch?: boolean };
type FetchHealth = { requested: number; returned: number; failedIds: string[]; fallbackIds: string[]; updatedAt: string | null };
type PackedIntradaySeries = Record<string, { provider: string; rows: Array<[timestamp: string, price: string]> }>;
type MarketCachePayload = { schemaVersion: number; savedAt: string; quotes: Record<string, RemoteQuote>; benchmarks?: Benchmark[]; intraday?: IntradayBar[]; intradaySeries?: PackedIntradaySeries };
type HistoryCachePayload = { schemaVersion: number; savedAt?: string; checksum?: string; derivationVersion?: string; bars?: MarketBar[]; series?: PackedHistorySeries; corporateActions: CorporateAction[]; inceptionDates?: Record<string, string> };
type TouchGesture = {
  startX: number;
  startY: number;
  lastX: number;
  lastAt: number;
  velocityX: number;
  distanceX: number;
  axis: "pending" | "horizontal" | "vertical" | "cancelled";
  currentIndex: number;
  pullEnabled: boolean;
  swipeBlocked: boolean;
};
type SwipePhase = "idle" | "dragging" | "settling";
type DataSecurityAction = "encrypted-backup" | "export-csv" | "export-json" | "lock" | "logout";

const NAV_ITEMS: Array<{ id: View; label: string; shortLabel: string; icon: typeof LayoutDashboard }> = [
  { id: "activity", label: "取引履歴", shortLabel: "取引", icon: FileClock },
  { id: "watchlist", label: "銘柄検索", shortLabel: "検索", icon: Search },
  { id: "overview", label: "一覧", shortLabel: "一覧", icon: LayoutDashboard },
  { id: "notifications", label: "通知", shortLabel: "通知", icon: Bell },
  { id: "settings", label: "設定", shortLabel: "設定", icon: Settings },
];
const MOBILE_NAV_ITEMS = [NAV_ITEMS[0], NAV_ITEMS[1], NAV_ITEMS[2], NAV_ITEMS[3], NAV_ITEMS[4]];
const DESKTOP_TOUCH_NAVIGATION_ORDER = NAV_ITEMS.map((item) => item.id);
const MOBILE_TOUCH_NAVIGATION_ORDER = MOBILE_NAV_ITEMS.map((item) => item.id);
const MOBILE_VIEW_INDEX: Record<string, number> = {
  activity: 0,
  watchlist: 1,
  overview: 2,
  notifications: 3,
  settings: 4,
};
const PORTFOLIO_RANGES: RangeKey[] = ["1D", "1W", "1M", "3M", "YTD", "ALL"];
const UPDATE_FREQUENCIES: UpdateFrequency[] = [10, 15, 30, 60];
const HISTORY_NETWORK_REVALIDATE_MS = 6 * 60 * 60 * 1000;
const HISTORY_INTEGRITY_CHECK_MS = 15 * 60 * 1000;
const PULL_REFRESH_THRESHOLD = 64;
const PULL_REFRESH_MAX = 100;
const PULL_REFRESH_HOLD_HEIGHT = 56;
const TOUCH_NAVIGATION_LOCK_PX = 12;
const SWIPE_SETTLE_MS = 220;
const MOBILE_LAYOUT_QUERY = "(max-width: 840px), (max-height: 500px) and (orientation: landscape)";
const motionDuration = (duration: number) => window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 20 : duration;
const PERFORMANCE_DERIVATION_VERSION = "additive-stock-valuation-v3-continuous-days";
const FX_SECURITY_ID = "sec-fx-usdjpy";
const MARKET_CACHE_KEY = "market-v8";
const HISTORY_CACHE_KEY = "history-v8";
const SUMMARY_AMOUNTS_VISIBLE_KEY = "kabutora-summary-amounts-visible";
const HIDE_SCROLLBAR_KEY = "kabutora-hide-scrollbar";
const PRICE_ALERT_THRESHOLD_KEY = "kabutora-price-alert-threshold";
const HIDDEN_AMOUNT = "••••••";
const LEGACY_MARKET_CACHE_KEYS = ["kabutora-market-cache-v5", "kabutora-market-cache-v4", "kabutora-market-cache-v3"];
const LEGACY_HISTORY_CACHE_KEYS = ["kabutora-history-cache-v7", "kabutora-history-cache-v6", "kabutora-history-cache-v5", "kabutora-history-cache-v4", "kabutora-history-cache-v3", "kabutora-history-cache-v2"];
const rangeLabel = (range: RangeKey) => range;

function filterDatedHistory<T extends { date: string }>(points: T[], range: RangeKey, customRange: CustomDateRange | null) {
  if (range === "CUSTOM" && customRange) return points.filter((point) => point.date.slice(0, 10) >= customRange.from && point.date.slice(0, 10) <= customRange.to);
  const latestDate = points.at(-1)?.date.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const cutoff = new Date(`${latestDate}T00:00:00Z`);
  if (range === "1W") cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  if (range === "1M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
  if (range === "3M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
  if (range === "YTD") cutoff.setUTCMonth(0, 1);
  return range === "ALL" ? points : points.filter((point) => new Date(`${point.date.slice(0, 10)}T00:00:00Z`) >= cutoff);
}

const number = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 4 });
const benchmarkNumber = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fxNumber = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const money = (value: number, currency = "JPY") => new Intl.NumberFormat("ja-JP", { style: "currency", currency: currency === "NATIVE" ? "JPY" : currency, maximumFractionDigits: currency === "JPY" ? 0 : 2 }).format(value);
const signedMoney = (value: number, currency: string) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value), currency)}`;
const maybeMoney = (value: string | number | null | undefined, currency: string) => value == null ? "—" : money(Number(value), currency);
const maybeSignedMoney = (value: string | number | null | undefined, currency: string) => value == null ? "—" : signedMoney(Number(value), currency);
const signedPercent = (value: number | null, digits = 2) => value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
const timeJa = (value: string, timeZone = "Asia/Tokyo") => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
};
const dateJa = calendarDateLabelJa;
const shortDateTimeJa = (value: string, timeZone = "Asia/Tokyo") => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${new Intl.DateTimeFormat("ja-JP", { timeZone, month: "numeric", day: "numeric" }).format(date)} ${timeJa(value, timeZone)}`;
};
const costBasisGroupForAccount = (account: Seed["accounts"][number] | undefined, fallbackAccountId: string) => account
  ? `${account.broker.trim().normalize("NFKC").toLocaleLowerCase("ja-JP")}\u0000${account.accountType.trim().normalize("NFKC").toLocaleLowerCase("ja-JP")}`
  : `account\u0000${fallbackAccountId}`;

const isFundSecurity = (security: { assetType?: string; exchangeMic?: string } | null | undefined) => security?.assetType === "fund" || security?.exchangeMic === "JPFD" || security?.exchangeMic === "XFND";
const isIndexSecurity = (security: { assetType?: string; exchangeMic?: string } | null | undefined) => security?.assetType === "index" || security?.exchangeMic === "XIND";
const securityPriceUnit = (security: { priceUnit?: string } | null | undefined) => {
  const unit = Number(security?.priceUnit ?? 1);
  return Number.isFinite(unit) && unit > 0 ? unit : 1;
};
const securityQuantityUnit = (security: { assetType?: string; exchangeMic?: string } | null | undefined) => isFundSecurity(security) ? "口" : isIndexSecurity(security) ? "単位" : "株";
const securityPriceBasis = (security: { assetType?: string; exchangeMic?: string; priceUnit?: string } | null | undefined) => isFundSecurity(security) ? securityPriceUnit(security) === 10_000 ? "1万口" : "1口" : "";

const shortMoney = (value: number, currency: DisplayCurrency | string) => {
  const effective = currency === "NATIVE" ? "JPY" : currency;
  if (effective === "JPY" && Math.abs(value) >= 100_000_000) return `¥${(value / 100_000_000).toFixed(2)}億`;
  if (effective === "JPY" && Math.abs(value) >= 10_000) return `¥${compactNumber(value / 10_000)}万`;
  if (effective === "USD" && Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (effective === "USD" && Math.abs(value) >= 1_000) return `$${compactNumber(value / 1_000)}K`;
  return money(value, effective);
};

const compactMoney = (value: number, currency: DisplayCurrency | string, signed = false) => {
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  const absolute = Math.abs(value);
  const effective = currency === "NATIVE" ? "JPY" : currency;
  if (effective === "JPY" && absolute >= 10_000) return `${sign}¥${compactNumber(absolute / 10_000)}万`;
  if (effective === "USD" && absolute >= 1_000) return `${sign}$${compactNumber(absolute / 1_000)}K`;
  return `${sign}${money(absolute, effective)}`;
};

const formatDayGainMoney = (value: number, currency: DisplayCurrency | string) => {
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  const absolute = Math.abs(value);
  const effective = currency === "NATIVE" ? "JPY" : currency;
  if (effective === "JPY") {
    if (absolute >= 100_000_000) return `${sign}¥${(absolute / 100_000_000).toFixed(2)}億`;
    if (absolute >= 1_000_000) return `${sign}¥${compactNumber(absolute / 10_000)}万`;
    return `${sign}¥${number.format(Math.round(absolute))}`;
  }
  if (effective === "USD") {
    if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
    if (absolute >= 10_000) return `${sign}$${compactNumber(absolute / 1_000)}K`;
    return `${sign}${money(absolute, effective)}`;
  }
  return `${sign}${money(absolute, effective)}`;
};

function validUsdJpy(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 50 && value <= 300;
}

function convertAmount(value: string | number | null | undefined, from: string, to: string, usdJpy: number | null) {
  if (value == null) return null;
  if (from === to || to === "NATIVE") return String(value);
  if (!validUsdJpy(usdJpy)) return null;
  const amount = new Decimal(value);
  return (from === "USD" ? amount.mul(usdJpy) : amount.div(usdJpy)).toString();
}

const csvEscape = (value: unknown) => {
  const raw = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};

const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

function packIntradayBars(bars: IntradayBar[]): PackedIntradaySeries {
  const series: PackedIntradaySeries = {};
  for (const bar of bars) {
    const current = series[bar.securityId] ?? { provider: bar.provider, rows: [] };
    current.provider = bar.provider || current.provider;
    current.rows.push([bar.timestamp, bar.price]);
    series[bar.securityId] = current;
  }
  return series;
}

function unpackIntradayBars(series: PackedIntradaySeries | null | undefined) {
  if (!series) return [];
  return Object.entries(series).flatMap(([securityId, value]) => value.rows.map(([timestamp, price]) => ({ securityId, timestamp, price, provider: value.provider })));
}

const freshnessLabel: Record<MarketQuote["freshness"], string> = {
  live: "LIVE",
  near_live: "NEAR LIVE",
  delayed: "DELAYED",
  cached: "CACHED",
  stale: "STALE",
  manual: "MANUAL",
};

const seededActions = corporateActionSeed.actions as CorporateAction[];
const seededMarketNotices = marketNoticeSeed.notices as ExternalMarketNotice[];
const notificationTypes = new Set<PortfolioNotification["type"]>(["SPLIT", "REVERSE_SPLIT", "LIMIT_UP", "LIMIT_DOWN", "PRICE_UP", "PRICE_DOWN", "TOB", "CORPORATE"]);

function readStoredIds(storage: Storage, key: string) {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200))];
  } catch {
    storage.removeItem(key);
    return [];
  }
}

function readStoredNotifications(storage: Storage) {
  const key = "kabutora-notification-history-v1";
  try {
    const value = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return mergePortfolioNotifications(value.filter((item): item is PortfolioNotification => {
      if (!item || typeof item !== "object") return false;
      const notice = item as Partial<PortfolioNotification>;
      return typeof notice.id === "string" && notice.id.length > 0 && notice.id.length <= 300
        && typeof notice.securityId === "string" && notice.securityId.length > 0 && notice.securityId.length <= 300
        && typeof notice.type === "string" && notificationTypes.has(notice.type as PortfolioNotification["type"])
        && typeof notice.occurredAt === "string" && Number.isFinite(Date.parse(notice.occurredAt))
        && typeof notice.title === "string" && typeof notice.summary === "string" && typeof notice.source === "string";
    }));
  } catch {
    storage.removeItem(key);
    return [];
  }
}

function mergeActions(...groups: CorporateAction[][]) {
  return [...new Map(groups.flat().map((action) => [action.id, action])).values()].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

function latestMarketSessions(responses: Array<{ payload: { marketSessions?: MarketSessionStatus[] } }>) {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const sessions = responses[index].payload.marketSessions;
    if (sessions?.length) return sessions;
  }
  return null;
}

function quoteTradeSourceLabel(quote: MarketQuote) {
  return quote.venueCode === "FUND" ? "基準価額" : quote.venueCode === "INDEX" ? "指数値" : quote.venueCode === "JNX" ? "PTS約定" : quote.venueCode === "TSE" && quote.priceType === "official_close" ? "東証終値" : "最終約定";
}

function quoteTimestampLabel(quote: MarketQuote & { exchangeMic?: string }, timeZone?: string) {
  return `取得 ${shortDateTimeJa(quote.fetchedAt)}（端末） · ${quoteTradeSourceLabel(quote)} ${marketDateTimeLabel(quote.marketTimestamp, quote.exchangeMic, timeZone)}（市場現地） · ${freshnessLabel[quote.freshness]}`;
}

function tickerQuoteTimestampLabel(quote: MarketQuote & { exchangeMic?: string }, timeZone?: string) {
  const freshness = quote.freshness === "near_live" ? "" : ` · ${freshnessLabel[quote.freshness]}`;
  return `取得 ${shortDateTimeJa(quote.fetchedAt)}（端末） · ${quoteTradeSourceLabel(quote)} ${marketDateTimeLabel(quote.marketTimestamp, quote.exchangeMic, timeZone)}（市場現地）${freshness}`;
}

function Brand() {
  return <div className="brand" aria-label="株トラ"><strong>株トラ</strong></div>;
}

export type DashboardProps = {
  seed: Seed;
  initialServerTimeMs?: number;
  initialMarketSessions?: MarketSessionStatus[];
  persistenceMode?: "local" | "cloud";
  onTransactionsChange?: (transactions: Seed["transactions"]) => Promise<void> | void;
  onAccountsChange?: (accounts: Seed["accounts"]) => Promise<void> | void;
  onSecuritiesChange?: (securities: Seed["securities"]) => Promise<void> | void;
  onEncryptedBackup?: (seed: Seed) => void;
  allowPlaintextExport?: boolean;
  allowPersistentMarketCache?: boolean;
  onLock?: () => Promise<void> | void;
  onLogout?: () => Promise<void> | void;
  onStartupReady?: () => void;
};

const FastOverview = memo(Overview);
const FastWatchlistView = memo(WatchlistView);
const FastActivityView = memo(ActivityView);
const FastNotificationsView = memo(NotificationsView);
const FastSettingsView = memo(SettingsView);
const FastFxRates = memo(FxRates);
const FastMarketTape = memo(MarketTape);

export default function Dashboard({ seed, initialServerTimeMs, initialMarketSessions = [], persistenceMode = "local", onTransactionsChange, onAccountsChange, onSecuritiesChange, onEncryptedBackup, allowPlaintextExport = true, allowPersistentMarketCache = true, onLock, onLogout, onStartupReady }: DashboardProps) {
  const [view, setView] = useState<View>("overview");
  const renderedView = view;
  const activeViewRef = useRef<View>(view);
  const detailReturnViewRef = useRef<View>("overview");
  const [detailReturnView, setDetailReturnView] = useState<View>("overview");
  const [mountedViews, setMountedViews] = useState<Set<View>>(() => new Set<View>(["overview"]));
  const [watchlist, setWatchlist] = useState<SearchSecurity[]>([]);
  const [range, setRange] = useState<RangeKey>("ALL");
  const [customRange, setCustomRange] = useState<CustomDateRange | null>(null);
  const [dark, setDark] = useState(false);
  const [accentTheme, setAccentTheme] = useState<AccentTheme>("graphite");
  const [tradeOpen, setTradeOpen] = useState(false);
  const [transactions, setTransactions] = useState<Seed["transactions"]>(seed.transactions);
  const [accounts, setAccounts] = useState<Seed["accounts"]>(seed.accounts);
  const [brokerFilter, setBrokerFilter] = useState("ALL");
  const [marketFilter, setMarketFilter] = useState<PortfolioFilter>("ALL");
  const [summaryAmountsVisible, setSummaryAmountsVisible] = useState(true);
  const [hideScrollbar, setHideScrollbar] = useState(true);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>((seed.portfolio.baseCurrency === "USD" ? "USD" : "JPY"));

  const handleMarketFilterChange = (nextFilter: PortfolioFilter) => {
    setMarketFilter(nextFilter);
  };

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
  const [securityQuery, setSecurityQuery] = useState("");
  const [securitySuggestionIndex, setSecuritySuggestionIndex] = useState(0);
  const [remoteSecurityResults, setRemoteSecurityResults] = useState<SearchSecurity[]>([]);
  const [securitySearchStatus, setSecuritySearchStatus] = useState<MarketStatus>("idle");
  const [quotes, setQuotes] = useState<Record<string, RemoteQuote>>({});
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [intradayBars, setIntradayBars] = useState<IntradayBar[]>([]);
  const [historyBars, setHistoryBars] = useState<MarketBar[]>([]);
  const [historyInceptionDates, setHistoryInceptionDates] = useState<Record<string, string>>({});
  const [corporateActions, setCorporateActions] = useState<CorporateAction[]>(seededActions);
  const [quoteStatus, setQuoteStatus] = useState<MarketStatus>("loading");
  const [benchmarkStatus, setBenchmarkStatus] = useState<MarketStatus>("loading");
  const [marketStartupReady, setMarketStartupReady] = useState(false);
  const [startupCoverVisible, setStartupCoverVisible] = useState(true);
  const [startupCoverExiting, setStartupCoverExiting] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<MarketStatus>("idle");
  const [historyRequested, setHistoryRequested] = useState(false);
  const [historyQuality, setHistoryQuality] = useState<HistoryQuality | null>(null);
  const [historyCacheMeta, setHistoryCacheMeta] = useState<HistoryCacheMeta | null>(null);
  const [acknowledgedActionIds, setAcknowledgedActionIds] = useState<string[]>([]);
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>([]);
  const [notificationHistory, setNotificationHistory] = useState<PortfolioNotification[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [updateFrequency, setUpdateFrequency] = useState<UpdateFrequency>(10);
  const [priceAlertThreshold, setPriceAlertThreshold] = useState<number>(DEFAULT_PRICE_ALERT_PERCENT);
  const [marketError, setMarketError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [quoteHealth, setQuoteHealth] = useState<FetchHealth>({ requested: 0, returned: 0, failedIds: [], fallbackIds: [], updatedAt: null });
  const [historyHealth, setHistoryHealth] = useState<FetchHealth>({ requested: 0, returned: 0, failedIds: [], fallbackIds: [], updatedAt: null });
  const [hydrated, setHydrated] = useState(false);
  const initialClockMs = Number.isFinite(initialServerTimeMs) ? initialServerTimeMs! : Date.now();
  const [sessionClock, setSessionClock] = useState<number | null>(() => Number.isFinite(initialClockMs) ? initialClockMs : null);
  const [serverMarketSessions, setServerMarketSessions] = useState<MarketSessionStatus[]>(initialMarketSessions);
  const [apiUsage, setApiUsage] = useState({ quoteRequests: 0, benchmarkRequests: 0, historyRequests: 0, searchRequests: 0, historyCacheHits: 0, integrityChecks: 0, lastQuoteRequest: null as string | null, lastBenchmarkRequest: null as string | null, lastHistoryRequest: null as string | null, lastSearchRequest: null as string | null });
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const touchGesture = useRef<TouchGesture | null>(null);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
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
  const [quoteRefreshToken, setQuoteRefreshToken] = useState(0);
  const quotesRef = useRef(quotes);
  const benchmarksRef = useRef(benchmarks);
  const intradayBarsRef = useRef(intradayBars);
  const historyRequestInFlight = useRef(false);
  const historyReloadPending = useRef(false);
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

  useEffect(() => {
    const preferenceStorage = allowPersistentMarketCache ? localStorage : sessionStorage;
    const savedTheme = localStorage.getItem("kabutora-theme");
    const savedAccent = localStorage.getItem("kabutora-accent") as AccentTheme | null;
    const savedCustomSecurities = null;
    const savedAutoRefresh = localStorage.getItem("kabutora-auto-refresh");
    const savedUpdateFrequency = Number(localStorage.getItem("kabutora-update-frequency"));
    const savedDisplayCurrency = localStorage.getItem("kabutora-display-currency") as DisplayCurrency | null;
    const savedMarketFilter = localStorage.getItem("kabutora-market-filter") as PortfolioFilter | null;
    const savedSummaryAmountsVisible = localStorage.getItem(SUMMARY_AMOUNTS_VISIBLE_KEY);
    const savedHideScrollbar = localStorage.getItem(HIDE_SCROLLBAR_KEY);
    const savedSummaryRange = localStorage.getItem("kabutora-summary-range") as RangeKey | null;
    const savedSummaryCustomRange = localStorage.getItem("kabutora-summary-custom-range");
    const savedPriceAlertThreshold = Number(localStorage.getItem(PRICE_ALERT_THRESHOLD_KEY));
    const savedAcknowledgedActions = readStoredIds(preferenceStorage, "kabutora-acknowledged-actions-v1");
    const savedReadNotifications = readStoredIds(preferenceStorage, "kabutora-read-notifications-v1");
    const savedNotificationHistory = readStoredNotifications(preferenceStorage);
    const savedWatchlist = preferenceStorage.getItem("kabutora-watchlist-v1");
    if (savedWatchlist) {
      try {
        const parsed = JSON.parse(savedWatchlist) as SearchSecurity[];
        if (Array.isArray(parsed)) setWatchlist(parsed);
      } catch {
        preferenceStorage.removeItem("kabutora-watchlist-v1");
      }
    }
    localStorage.removeItem("kabutora-transactions");
    localStorage.removeItem("kabutora-accounts-v1");
    localStorage.removeItem("kabutora-custom-securities-v1");
    if (savedTheme === "dark") setDark(true);
    if (savedAccent && ["graphite", "blue", "forest", "plum"].includes(savedAccent)) setAccentTheme(savedAccent);
    if (savedAutoRefresh === "false") setAutoRefresh(false);
    if ([10, 15, 30, 60].includes(savedUpdateFrequency)) setUpdateFrequency(savedUpdateFrequency as UpdateFrequency);
    if (savedPriceAlertThreshold && (PRICE_ALERT_THRESHOLDS as readonly number[]).includes(savedPriceAlertThreshold)) {
      setPriceAlertThreshold(savedPriceAlertThreshold);
    }
    if (savedDisplayCurrency === "JPY" || savedDisplayCurrency === "USD" || savedDisplayCurrency === "NATIVE") setDisplayCurrency(savedDisplayCurrency);
    if (savedMarketFilter === "ALL" || savedMarketFilter === "JP" || savedMarketFilter === "US" || savedMarketFilter === "FUNDS_INDEXES") setMarketFilter(savedMarketFilter);
    if (savedSummaryRange && (PORTFOLIO_RANGES.includes(savedSummaryRange) || savedSummaryRange === "CUSTOM")) setRange(savedSummaryRange);
    if (savedSummaryCustomRange) {
      try {
        const parsed = JSON.parse(savedSummaryCustomRange) as CustomDateRange;
        if (parsed && typeof parsed.from === "string" && typeof parsed.to === "string") setCustomRange(parsed);
      } catch {}
    }
    if (savedSummaryAmountsVisible === "false") setSummaryAmountsVisible(false);
    if (savedHideScrollbar === "false") setHideScrollbar(false);
    setAcknowledgedActionIds(savedAcknowledgedActions);
    setReadNotificationIds(savedReadNotifications);
    setNotificationHistory(savedNotificationHistory);
    if (savedCustomSecurities) {
      try { setCustomSecurities(JSON.parse(savedCustomSecurities)); } catch { localStorage.removeItem("kabutora-custom-securities-v1"); }
    }
    let cancelled = false;
    const hydrateMarketData = async () => {
      let hasUsableCachedMarket = false;
      const [cachedMarket, cachedHistory] = allowPersistentMarketCache
        ? await Promise.all([
            readMarketCache<MarketCachePayload>(MARKET_CACHE_KEY, LEGACY_MARKET_CACHE_KEYS),
            readMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, LEGACY_HISTORY_CACHE_KEYS),
          ])
        : [null, null];
      if (cancelled) return;
      if (cachedMarket) {
        try {
          const oldestUsableTimestamp = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const cachedQuotes = Object.fromEntries(Object.entries(cachedMarket.quotes ?? {}).filter(([, quote]) => new Date(quote.marketTimestamp).getTime() >= oldestUsableTimestamp));
          const cachedBenchmarks = (cachedMarket.benchmarks ?? []).filter((benchmark) => new Date(benchmark.marketTimestamp).getTime() >= oldestUsableTimestamp);
          const cachedIntraday = cachedMarket.intradaySeries ? unpackIntradayBars(cachedMarket.intradaySeries) : cachedMarket.intraday ?? [];
          setQuotes(cachedQuotes);
          quotesRef.current = cachedQuotes;
          setBenchmarks(cachedBenchmarks);
          setIntradayBars(cachedIntraday.filter((bar) => new Date(bar.timestamp).getTime() >= oldestUsableTimestamp));
          if (Object.keys(cachedQuotes).length) {
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
          setHistoryBars(inspected.bars);
          setHistoryInceptionDates(cachedHistory.inceptionDates ?? {});
          setCorporateActions(inspected.actions);
          setHistoryQuality({ ...inspected.quality, status: integrityMismatch ? "warning" : inspected.quality.status });
          setHistoryCacheMeta({ savedAt, checksum: inspected.quality.checksum, integrityMismatch });
          setHistoryStatus("partial");
          setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
          void writeMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, {
            schemaVersion: 8,
            derivationVersion: PERFORMANCE_DERIVATION_VERSION,
            savedAt,
            checksum: inspected.quality.checksum,
            series: packHistoryBars(inspected.bars),
            corporateActions: inspected.actions,
            inceptionDates: cachedHistory.inceptionDates ?? {},
          }, LEGACY_HISTORY_CACHE_KEYS);
        } catch {
          // Corrupt legacy snapshots are ignored and replaced by a network fetch.
        }
      }
      if (hasUsableCachedMarket) setMarketStartupReady(true);
      setHydrated(true);
    };
    void hydrateMarketData();
    return () => { cancelled = true; };
  }, [allowPersistentMarketCache, persistenceMode]);

  useEffect(() => {
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
    updateSessionClock();
    const timer = window.setInterval(updateSessionClock, 30_000);
    document.addEventListener("visibilitychange", updateSessionClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateSessionClock);
    };
  }, []);

  useEffect(() => {
    if (persistenceMode === "cloud") {
      setTransactions(seed.transactions);
      setAccounts(seed.accounts);
    }
  }, [persistenceMode, seed.accounts, seed.transactions]);

  useEffect(() => {
    if (selectedAccountId === "__custom__" || accounts.some((account) => account.id === selectedAccountId && (!account.archivedAt || editingTransaction?.accountId === account.id))) return;
    setSelectedAccountId(accounts.find((account) => account.broker !== "現金口座" && !account.archivedAt)?.id ?? accounts.find((account) => !account.archivedAt)?.id ?? "");
  }, [accounts, editingTransaction, selectedAccountId]);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("kabutora-theme", dark ? "dark" : "light");
  }, [dark, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.dataset.accent = accentTheme;
    localStorage.setItem("kabutora-accent", accentTheme);
  }, [accentTheme, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const preferenceStorage = allowPersistentMarketCache ? localStorage : sessionStorage;
    preferenceStorage.setItem("kabutora-acknowledged-actions-v1", JSON.stringify(acknowledgedActionIds.slice(-1000)));
  }, [acknowledgedActionIds, allowPersistentMarketCache, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const preferenceStorage = allowPersistentMarketCache ? localStorage : sessionStorage;
    preferenceStorage.setItem("kabutora-read-notifications-v1", JSON.stringify(readNotificationIds));
  }, [allowPersistentMarketCache, hydrated, readNotificationIds]);

  useEffect(() => {
    if (!hydrated) return;
    const preferenceStorage = allowPersistentMarketCache ? localStorage : sessionStorage;
    preferenceStorage.setItem("kabutora-notification-history-v1", JSON.stringify(notificationHistory));
  }, [allowPersistentMarketCache, hydrated, notificationHistory]);

  useEffect(() => {
    if (!hydrated) return;
    const preferenceStorage = allowPersistentMarketCache ? localStorage : sessionStorage;
    preferenceStorage.setItem("kabutora-watchlist-v1", JSON.stringify(watchlist));
  }, [allowPersistentMarketCache, hydrated, watchlist]);

  useEffect(() => {
    localStorage.setItem("kabutora-auto-refresh", String(autoRefresh));
  }, [autoRefresh]);

  useEffect(() => {
    localStorage.setItem("kabutora-update-frequency", String(updateFrequency));
  }, [updateFrequency]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(PRICE_ALERT_THRESHOLD_KEY, String(priceAlertThreshold));
  }, [hydrated, priceAlertThreshold]);

  useEffect(() => {
    localStorage.setItem("kabutora-display-currency", displayCurrency);
  }, [displayCurrency]);

  useEffect(() => {
    localStorage.setItem("kabutora-market-filter", marketFilter);
  }, [marketFilter]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(SUMMARY_AMOUNTS_VISIBLE_KEY, String(summaryAmountsVisible));
  }, [hydrated, summaryAmountsVisible]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(HIDE_SCROLLBAR_KEY, String(hideScrollbar));
    document.documentElement.dataset.hideScrollbar = hideScrollbar ? "true" : "false";
  }, [hideScrollbar, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("kabutora-summary-range", range);
  }, [hydrated, range]);

  useEffect(() => {
    if (!hydrated) return;
    if (customRange) {
      localStorage.setItem("kabutora-summary-custom-range", JSON.stringify(customRange));
    } else {
      localStorage.removeItem("kabutora-summary-custom-range");
    }
  }, [customRange, hydrated]);


  useEffect(() => {
    if (!allowPersistentMarketCache || !hydrated || !Object.keys(quotes).length) return;
    const timer = window.setTimeout(() => {
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

  useEffect(() => {
    const query = securityQuery.trim();
    if (!tradeOpen || query.length < 1) {
      setRemoteSecurityResults([]);
      setSecuritySearchStatus("idle");
      return;
    }
    setSecuritySearchStatus("loading");
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchMarketSecurities<SearchSecurity>(query, () => {
        setApiUsage((current) => ({ ...current, searchRequests: current.searchRequests + 1, lastSearchRequest: new Date().toISOString() }));
      }).then((results) => {
        if (cancelled) return;
        setRemoteSecurityResults(results);
        setSecuritySearchStatus("ready");
      }).catch(() => {
        if (cancelled) return;
        setRemoteSecurityResults([]);
        setSecuritySearchStatus("error");
      });
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [securityQuery, tradeOpen]);

  const allSecurities = useMemo<SearchSecurity[]>(() => [
    ...new Map<SearchSecurity["id"], SearchSecurity>([
      ...(seed.securities as SearchSecurity[]),
      ...customSecurities,
      ...watchlist,
    ].map((security) => [security.id, security])).values(),
  ], [customSecurities, seed.securities, watchlist]);
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
  const quoteSecurityIds = useMemo(() => [...new Set([
    ...positionSeed.holdings.map((holding) => holding.securityId),
    ...watchlist.map((item) => item.id),
    ...(detailSecurityScope ? [detailSecurityScope] : []),
  ])].sort().join(","), [detailSecurityScope, positionSeed.holdings, watchlist]);
  const hasForeignTransactions = useMemo(() => transactions.some((transaction) => transaction.tradeCurrency !== "JPY"), [transactions]);
  const needsFxHistory = useMemo(() => displayCurrency === "USD" ? transactions.some((t) => t.tradeCurrency !== "USD") : hasForeignTransactions, [displayCurrency, hasForeignTransactions, transactions]);
  const historySecurityIds = useMemo(() => [...new Set([
    ...transactions.map((transaction) => transaction.securityId).filter((value): value is string => Boolean(value)),
    ...(needsFxHistory ? [FX_SECURITY_ID] : []),
    ...(detailSecurityScope ? [detailSecurityScope] : []),
  ])].sort().join(","), [detailSecurityScope, needsFxHistory, transactions]);
  const historyCoverageRequired = useMemo(() => {
    const earliestBySecurity = new Map<string, string>();
    for (const transaction of transactions) {
      if (!transaction.securityId) continue;
      const date = transaction.tradeDate.slice(0, 10);
      const current = earliestBySecurity.get(transaction.securityId);
      if (!current || date < current) earliestBySecurity.set(transaction.securityId, date);
    }
    if (needsFxHistory) {
      const earliestConverted = transactions.filter((transaction) => transaction.tradeCurrency !== "JPY").map((transaction) => transaction.tradeDate.slice(0, 10)).sort()[0];
      if (earliestConverted) earliestBySecurity.set(FX_SECURITY_ID, earliestConverted);
    }
    if (detailSecurityScope && !earliestBySecurity.has(detailSecurityScope)) {
      const fiveYearsAgo = new Date();
      fiveYearsAgo.setUTCFullYear(fiveYearsAgo.getUTCFullYear() - 5);
      earliestBySecurity.set(detailSecurityScope, fiveYearsAgo.toISOString().slice(0, 10));
    }
    return earliestBySecurity;
  }, [detailSecurityScope, needsFxHistory, transactions]);
  const needsHistoryBackfill = useCallback((bars: MarketBar[]) => missingHistoryRequirements(bars, historyCoverageRequired, historyInceptionDates).length > 0, [historyCoverageRequired, historyInceptionDates]);

  const loadQuotes = useCallback(async (force = false, mode: "full" | "incremental" | "scheduled" = "incremental") => {
    if (!quoteSecurityIds) return;
    const allIds = splitSecurityIds(quoteSecurityIds, Number.MAX_SAFE_INTEGER).flat();
    const refreshNow = sessionClockRef.current ?? Date.now();
    const transitionIds = new Set(quoteSessionTransitionTargets(allIds, quotesRef.current, refreshNow));
    const targetIds = quoteRefreshTargets(allIds, quotesRef.current, { force, full: mode === "full", now: refreshNow });
    if (!targetIds.length) return;
    if (quoteRequestInFlight.current) {
      quoteReloadPending.current = true;
      return;
    }
    quoteRequestInFlight.current = true;
    const batches = splitSecurityIds(targetIds.join(","));
    setApiUsage((current) => ({ ...current, quoteRequests: current.quoteRequests + batches.length, lastQuoteRequest: new Date().toISOString() }));
    setQuoteStatus((current) => current === "ready" || current === "partial" ? current : "loading");
    try {
      const headers = { ...await getMarketAuthHeaders(), "Content-Type": "application/json" };
      const responses = await Promise.all(batches.map(async (securityIds) => {
        try {
          const response = await fetch("/api/market/quotes", {
            method: "POST",
            cache: "no-store",
            headers,
            body: JSON.stringify({
              securityIds: securityIds.join(","),
              refreshSecurityIds: securityIds.filter((securityId) => transitionIds.has(securityId)).join(","),
              includeIntraday: true,
              intradayRange: mode === "full" && intradayBarsRef.current.length === 0 ? "5d" : "1d",
              refresh: force,
            }),
            signal: AbortSignal.timeout(45_000),
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
      }));
      const payload = {
        quotes: responses.flatMap((item) => item.payload.quotes ?? []),
        intraday: responses.flatMap((item) => item.payload.intraday ?? []),
        failures: responses.flatMap((item) => item.payload.failures ?? []),
      };
      acceptTrustedServerTime(responses.map((item) => item.payload.generatedAt).filter((value): value is string => Boolean(value)).sort().at(-1));
      const latestServerSessions = latestMarketSessions(responses);
      if (latestServerSessions) setServerMarketSessions(latestServerSessions);
      if (!payload.quotes.length && responses.some((item) => !item.ok)) throw new Error(payload.failures[0]?.message ?? "価格を取得できませんでした");
      setQuotes((current) => {
        const next = { ...current };
        for (const quote of payload.quotes) next[quote.securityId] = quote;
        return next;
      });
      const returnedIds = new Set(payload.quotes.map((quote) => quote.securityId));
      setIntradayBars((current) => mergeIntradayBars(current, payload.intraday ?? []));
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
        setQuoteRefreshToken((current) => current + 1);
      }
    }
  }, [acceptTrustedServerTime, quoteSecurityIds]);

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
      const response = await fetch(`/api/market/benchmarks${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
        headers: await getMarketAuthHeaders(),
        signal: AbortSignal.timeout(45_000),
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
    const plan = buildHistoryFetchPlan(historySecurityIds, historyCoverageRequired, historyBars, MARKET_REQUEST_BATCH_SIZE, historyInceptionDates);
    setApiUsage((current) => ({ ...current, historyRequests: current.historyRequests + plan.length, lastHistoryRequest: new Date().toISOString() }));
    setHistoryStatus("loading");
    setHistoryError("");
    try {
      const headers = { ...await getMarketAuthHeaders(), "Content-Type": "application/json" };
      const responses = await Promise.all(plan.map(async (batch) => {
        try {
          const response = await fetch("/api/market/history", {
            method: "POST",
            cache: "no-store",
            headers,
            body: JSON.stringify({ securityIds: batch.securityIds.join(","), from: batch.from, refresh: force || batch.forceRefresh === true }),
            signal: AbortSignal.timeout(60_000),
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
      }));
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
      setHistoryBars(inspected.bars);
      setHistoryInceptionDates(nextInceptionDates);
      setCorporateActions(inspected.actions);
      setHistoryQuality(inspected.quality);
      setHistoryCacheMeta({ savedAt, checksum: inspected.quality.checksum });
      setHistoryHealth({ requested: requestedIds.length, returned: requestedIds.length - failedResponseIds.size, failedIds, fallbackIds: cachedFallbackIds, updatedAt: savedAt });
      setApiUsage((current) => ({ ...current, integrityChecks: current.integrityChecks + 1 }));
      if (allowPersistentMarketCache) {
        void writeMarketCache<HistoryCachePayload>(HISTORY_CACHE_KEY, {
          schemaVersion: 8,
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
  }, [acceptTrustedServerTime, allowPersistentMarketCache, allSecurities, corporateActions, historyBars, historyCoverageRequired, historyInceptionDates, historySecurityIds]);

  useEffect(() => { quotesRef.current = quotes; }, [quotes]);
  useEffect(() => { benchmarksRef.current = benchmarks; }, [benchmarks]);
  useEffect(() => { intradayBarsRef.current = intradayBars; }, [intradayBars]);
  useEffect(() => {
    if (!hydrated || marketStartupRunRef.current) return;
    marketStartupRunRef.current = true;
    const mode = intradayBarsRef.current.length ? "incremental" : "full";
    quoteEffectKeyRef.current = `${quoteSecurityIds}|${quoteRefreshToken}`;
    void Promise.allSettled([
      loadQuotes(false, mode),
      loadBenchmarks(),
    ]).then(() => setMarketStartupReady(true));
  }, [hydrated, loadBenchmarks, loadQuotes, quoteRefreshToken, quoteSecurityIds]);

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
    if (!hydrated || !["overview", "performance", "security", "notifications"].includes(view) || historyRequested) return;
    setHistoryRequested(true);
    const cacheAge = historyCacheMeta?.savedAt ? Date.now() - new Date(historyCacheMeta.savedAt).getTime() : Number.POSITIVE_INFINITY;
    if (historyBars.length && cacheAge < HISTORY_NETWORK_REVALIDATE_MS && !historyCacheMeta?.integrityMismatch && !needsHistoryBackfill(historyBars)) {
      setHistoryStatus(historyQuality?.status === "warning" ? "partial" : "ready");
      setApiUsage((current) => ({ ...current, historyCacheHits: current.historyCacheHits + 1 }));
      return;
    }
    void loadHistory();
  }, [historyBars, historyCacheMeta, historyQuality, historyRequested, hydrated, loadHistory, needsHistoryBackfill, view]);

  const requirementSignature = useMemo(() => [...historyCoverageRequired].map(([securityId, date]) => `${securityId}:${date}`).sort().join("|"), [historyCoverageRequired]);
  useEffect(() => {
    if (!hydrated) return;
    if (historyRequirementKey.current && historyRequirementKey.current !== requirementSignature && needsHistoryBackfill(historyBars)) setHistoryRequested(false);
    historyRequirementKey.current = requirementSignature;
  }, [historyBars, hydrated, needsHistoryBackfill, requirementSignature]);

  useEffect(() => {
    if (!hydrated || !historyBars.length) return;
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
    const onVisibility = () => { if (document.visibilityState === "visible") inspectLocalCache(); };
    const timer = window.setInterval(inspectLocalCache, HISTORY_INTEGRITY_CHECK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [corporateActions, historyBars, historyCacheMeta, hydrated]);

  const hasActiveSession = Object.values(quotes).some((quote) => quote.session !== "closed");
  const effectiveUpdateMinutes = hasActiveSession ? Math.max(updateFrequency, 10) : Math.max(updateFrequency, 60);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadQuotes(false, "scheduled");
    }, effectiveUpdateMinutes * 60_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, effectiveUpdateMinutes, loadQuotes]);

  const usdJpyBenchmark = benchmarks.find((benchmark) => benchmark.id === "usd-jpy");
  const fxHistory = useMemo(() => historyBars.filter((bar) => bar.securityId === FX_SECURITY_ID).sort((a, b) => a.date.localeCompare(b.date)), [historyBars]);
  const currentUsdJpy = validUsdJpy(usdJpyBenchmark?.value)
    ? usdJpyBenchmark.value
    : Number(fxHistory.at(-1)?.close ?? Number.NaN);
  const previousUsdJpy = validUsdJpy(currentUsdJpy) && usdJpyBenchmark?.changeRatio != null && 1 + usdJpyBenchmark.changeRatio > 0
    ? currentUsdJpy / (1 + usdJpyBenchmark.changeRatio)
    : currentUsdJpy;
  const fxAtDate = useCallback((date: string) => {
    return historicalFxRateAtDate(fxHistory, date, validUsdJpy(currentUsdJpy) ? currentUsdJpy : null);
  }, [currentUsdJpy, fxHistory]);

  const nativeMarketSecurities = useMemo(
    () => allSecurities.map((security) => {
      const quote = quotes[security.id];
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
  const rawSecurityMap = useMemo(() => new Map(nativeMarketSecurities.map((security) => [security.id, security])), [nativeMarketSecurities]);
  const marketSecurities = useMemo(() => nativeMarketSecurities.map((security) => {
    if (displayCurrency === "NATIVE") return security;
    const nativeCurrency = security.currency;
    const quote = security.quote;
    if (!quote) return { ...security, nativeCurrency, currency: displayCurrency };
    const price = convertAmount(quote.price, nativeCurrency, displayCurrency, currentUsdJpy);
    const previousRegularClose = convertAmount(quote.previousRegularClose, nativeCurrency, displayCurrency, previousUsdJpy);
    if (price == null) return { ...security, nativeCurrency, currency: displayCurrency };
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
  const securityMap = useMemo(() => new Map(marketSecurities.map((security) => [security.id, security])), [marketSecurities]);
  const brokerOptions = useMemo(() => [...new Set(activeAccounts.map((account) => account.broker).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), [activeAccounts]);
  const brokerTransactions = useMemo(() => brokerFilter === "ALL" ? calculationTransactions : calculationTransactions.filter((transaction) => {
    const account = accountMap.get(transaction.accountId);
    return account?.broker === brokerFilter || transaction.original.broker === brokerFilter;
  }), [accountMap, brokerFilter, calculationTransactions]);
  const visibleTransactions = useMemo(() => marketFilter === "ALL" ? brokerTransactions : brokerTransactions.filter((transaction) => {
    const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
    if (security) return securityMatchesPortfolioFilter(security, marketFilter);
    if (marketFilter === "FUNDS_INDEXES") return false;
    return (transaction.tradeCurrency === "USD" ? "US" : "JP") === marketFilter;
  }), [brokerTransactions, marketFilter, rawSecurityMap]);
  const effectiveSummaryCurrency: "JPY" | "USD" = useMemo(() => {
    if (displayCurrency === "USD") return "USD";
    if (displayCurrency === "JPY") return "JPY";
    const distinctCurrencies = new Set(
      visibleTransactions
        .map((t) => (t.securityId ? rawSecurityMap.get(t.securityId)?.currency ?? t.tradeCurrency : t.tradeCurrency))
        .filter(Boolean),
    );
    if (distinctCurrencies.size === 1) {
      const single = [...distinctCurrencies][0];
      if (single === "USD" || single === "JPY") return single;
    }
    return "JPY";
  }, [displayCurrency, rawSecurityMap, visibleTransactions]);
  const summaryMarketSecurities = useMemo(() => nativeMarketSecurities.map((security) => {
    const nativeCurrency = security.currency;
    const quote = security.quote;
    if (!quote) return { ...security, nativeCurrency, currency: effectiveSummaryCurrency };
    const price = convertAmount(quote.price, nativeCurrency, effectiveSummaryCurrency, currentUsdJpy);
    const previousRegularClose = convertAmount(quote.previousRegularClose, nativeCurrency, effectiveSummaryCurrency, previousUsdJpy);
    if (price == null) return { ...security, nativeCurrency, currency: effectiveSummaryCurrency };
    return {
      ...security,
      nativeCurrency,
      currency: effectiveSummaryCurrency,
      quote: {
        ...quote,
        price,
        ...(previousRegularClose != null ? { previousRegularClose } : {}),
        ...(convertAmount(quote.dayOpen, nativeCurrency, effectiveSummaryCurrency, currentUsdJpy) != null ? { dayOpen: convertAmount(quote.dayOpen, nativeCurrency, effectiveSummaryCurrency, currentUsdJpy)! } : {}),
        ...(convertAmount(quote.dayHigh, nativeCurrency, effectiveSummaryCurrency, currentUsdJpy) != null ? { dayHigh: convertAmount(quote.dayHigh, nativeCurrency, effectiveSummaryCurrency, currentUsdJpy)! } : {}),
        ...(convertAmount(quote.dayLow, nativeCurrency, effectiveSummaryCurrency, currentUsdJpy) != null ? { dayLow: convertAmount(quote.dayLow, nativeCurrency, effectiveSummaryCurrency, currentUsdJpy)! } : {}),
      },
    };
  }), [currentUsdJpy, effectiveSummaryCurrency, nativeMarketSecurities, previousUsdJpy]);
  const convertedTransactions = useMemo(() => visibleTransactions.flatMap((transaction) => {
    const rate = fxAtDate(transaction.tradeDate);
    const grossAmount = convertAmount(transaction.grossAmount, transaction.tradeCurrency, effectiveSummaryCurrency, rate);
    const pricePerShare = convertAmount(transaction.pricePerShare, transaction.tradeCurrency, effectiveSummaryCurrency, rate);
    if (transaction.tradeCurrency !== effectiveSummaryCurrency && (!validUsdJpy(rate) || (transaction.grossAmount != null && grossAmount == null))) return [];
    return [{ ...transaction, grossAmount, pricePerShare, tradeCurrency: effectiveSummaryCurrency }];
  }), [effectiveSummaryCurrency, fxAtDate, visibleTransactions]);
  const derivedNotifications = useMemo(() => derivePortfolioNotifications({
    transactions: calculationTransactions,
    securities: nativeMarketSecurities,
    actions: applicableCorporateActions,
    bars: historyBars,
    intradayBars,
    externalNotices: seededMarketNotices,
    priceMoveThreshold: priceAlertThreshold / 100,
  }), [applicableCorporateActions, calculationTransactions, historyBars, intradayBars, nativeMarketSecurities, priceAlertThreshold, seededMarketNotices]);
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
  const visibleSecurityIds = useMemo(() => new Set(visibleTransactions.map((transaction) => transaction.securityId).filter(Boolean)), [visibleTransactions]);
  const allTransactionSecurityIds = useMemo(() => new Set(transactions.map((transaction) => transaction.securityId).filter((value): value is string => Boolean(value))), [transactions]);
  const unreadNotificationCount = useMemo(() => {
    const read = new Set(readNotificationIds);
    return portfolioNotifications.filter((notice) => !read.has(notice.id)).length;
  }, [portfolioNotifications, readNotificationIds]);
  const convertedHistoryBars = useMemo(() => historyBars.flatMap((bar) => {
    if (bar.securityId === FX_SECURITY_ID) return [];
    const nativeCurrency = rawSecurityMap.get(bar.securityId)?.currency ?? "JPY";
    const rate = fxAtDate(bar.date);
    const close = convertAmount(bar.close, nativeCurrency, effectiveSummaryCurrency, rate);
    const adjustedClose = convertAmount(bar.adjustedClose, nativeCurrency, effectiveSummaryCurrency, rate);
    if (close == null) return [];
    return [{ ...bar, close, ...(adjustedClose != null ? { adjustedClose } : {}) }];
  }), [effectiveSummaryCurrency, fxAtDate, historyBars, rawSecurityMap]);
  const visibleSummary = useMemo(() => calculateAverageCostPortfolio(convertedTransactions, summaryMarketSecurities, applicableCorporateActions), [applicableCorporateActions, convertedTransactions, summaryMarketSecurities]);
  const nativeSummary = useMemo(() => calculateAverageCostPortfolio(visibleTransactions, nativeMarketSecurities, applicableCorporateActions), [applicableCorporateActions, nativeMarketSecurities, visibleTransactions]);
  const securityScope = visibleTransactions.some((transaction) => transaction.securityId);
  const activeSummary = useMemo(() => projectStockPortfolio(visibleSummary), [visibleSummary]);
  const marketReconciliation = useMemo(() => {
    if (marketFilter !== "ALL") return { valid: true, differences: [] };
    const parts = (["JP", "US", "FUNDS_INDEXES"] as const).map((filter) => {
      const scoped = convertedTransactions.filter((transaction) => {
        const security = transaction.securityId ? rawSecurityMap.get(transaction.securityId) : null;
        if (security) return securityMatchesPortfolioFilter(security, filter);
        if (filter === "FUNDS_INDEXES") return false;
        return (transaction.tradeCurrency === "USD" ? "US" : "JP") === filter;
      });
      return calculateAverageCostPortfolio(scoped, summaryMarketSecurities, applicableCorporateActions);
    });
    return reconcilePortfolioParts(visibleSummary, parts);
  }, [applicableCorporateActions, convertedTransactions, marketFilter, rawSecurityMap, summaryMarketSecurities, visibleSummary]);
  const visibleConversionDates = visibleTransactions.filter((transaction) => transaction.tradeCurrency !== effectiveSummaryCurrency).map((transaction) => transaction.tradeDate.slice(0, 10)).sort();
  const fxHistoryComplete = !visibleConversionDates.length || Boolean(fxHistory[0]?.date && fxHistory[0].date <= visibleConversionDates[0]);
  const fxConversionReady = !visibleConversionDates.length || (validUsdJpy(currentUsdJpy) && fxHistoryComplete);
  const valuationComplete = fxConversionReady && marketReconciliation.valid && activeSummary.unpricedSecurityCount === 0 && (activeSummary.pricedSecurityCount > 0 || !securityScope);
  const totalValue = valuationComplete ? Number(activeSummary.totalValue) : null;
  const dayGain = valuationComplete ? Number(activeSummary.dayGain) : null;
  const previousValue = totalValue != null && dayGain != null ? totalValue - dayGain : null;
  const dayReturn = previousValue && dayGain != null ? dayGain / previousValue : null;
  const totalGain = Number(activeSummary.unrealizedGain) + Number(activeSummary.realizedGain);
  const totalReturn = valuationComplete && Number(activeSummary.costBasis) ? totalGain / Number(activeSummary.costBasis) : null;

  const displayHoldings = useMemo(() => {
    if (displayCurrency === "NATIVE") {
      return nativeSummary.holdings.map((holding) => {
        const security = rawSecurityMap.get(holding.securityId) ?? { ...seed.securities.find((s) => s.id === holding.securityId)!, quote: undefined as RemoteQuote | undefined };
        const summaryHolding = visibleSummary.holdings.find((h) => h.securityId === holding.securityId);
        return {
          ...holding,
          security,
          summaryMarketValue: summaryHolding?.marketValue ?? null,
        };
      });
    }
    return visibleSummary.holdings.map((holding) => ({
      ...holding,
      security: securityMap.get(holding.securityId)!,
      summaryMarketValue: holding.marketValue,
    }));
  }, [displayCurrency, nativeMarketSecurities, nativeSummary.holdings, rawSecurityMap, securityMap, seed.securities, visibleSummary.holdings]);

  const holdings = displayHoldings;

  const intradayBySecurity = useMemo(() => {
    const grouped = new Map<string, IntradayBar[]>();
    for (const bar of intradayBars) {
      const nativeCurrency = rawSecurityMap.get(bar.securityId)?.currency ?? "JPY";
      const targetCurrency = displayCurrency === "NATIVE" ? nativeCurrency : displayCurrency;
      const price = convertAmount(bar.price, nativeCurrency, targetCurrency, fxAtDate(bar.timestamp));
      if (price == null) continue;
      const rows = grouped.get(bar.securityId) ?? [];
      rows.push({ ...bar, price: price.toString() });
      grouped.set(bar.securityId, rows);
    }
    for (const rows of grouped.values()) rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return grouped;
  }, [displayCurrency, fxAtDate, intradayBars, rawSecurityMap]);

  const dailyHistoryBySecurity = useMemo(() => {
    const grouped = new Map<string, MarketBar[]>();
    const barsToUse = displayCurrency === "NATIVE" ? historyBars : convertedHistoryBars;
    for (const bar of barsToUse) {
      if (bar.securityId === FX_SECURITY_ID) continue;
      const rows = grouped.get(bar.securityId) ?? [];
      rows.push(bar);
      grouped.set(bar.securityId, rows);
    }
    for (const rows of grouped.values()) rows.sort((a, b) => a.date.localeCompare(b.date));
    return grouped;
  }, [convertedHistoryBars, displayCurrency, historyBars]);

  const reconstructedHistory = useMemo<PortfolioHistoryPoint[]>(
    () => reconstructPortfolioHistory(convertedTransactions, summaryMarketSecurities, convertedHistoryBars, applicableCorporateActions, todayKey).map((point) => ({
      ...point,
      totalValue: new Decimal(point.costBasis).plus(point.unrealizedGain).toString(),
      investedCapital: point.costBasis,
    })),
    [applicableCorporateActions, convertedHistoryBars, convertedTransactions, summaryMarketSecurities, todayKey],
  );
  const intradayHistory = useMemo(() => {
    const latestPrices = new Map<string, number>();
    const events: Array<{ securityId: string; timestamp: string; price: number }> = [];
    for (const holding of holdings) {
      const quote = (holding.security as { quote?: MarketQuote | RemoteQuote } | undefined)?.quote;
      const securityBars = intradayBySecurity.get(holding.securityId) ?? [];
      const startingPrice = securityBars.length ? Number(securityBars[0].price) : quote?.previousRegularClose == null ? Number(holding.currentPrice ?? 0) : Number(quote.previousRegularClose);
      latestPrices.set(holding.securityId, startingPrice);
      for (const bar of securityBars) {
        events.push({ securityId: holding.securityId, timestamp: bar.timestamp, price: Number(bar.price) });
      }
    }
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (!events.length) return [];
    const valueAtCurrentPrices = () => holdings.reduce((total, holding) => total + Number(holding.quantity) * (latestPrices.get(holding.securityId) ?? 0) / securityPriceUnit(holding.security), 0);
    const openingTime = new Date(events[0].timestamp);
    openingTime.setMinutes(openingTime.getMinutes() - 15);
    const points = [{ date: openingTime.toISOString(), value: valueAtCurrentPrices(), capital: Number(activeSummary.costBasis) }];
    for (let index = 0; index < events.length;) {
      const timestamp = events[index].timestamp;
      while (index < events.length && events[index].timestamp === timestamp) {
        latestPrices.set(events[index].securityId, events[index].price);
        index += 1;
      }
      points.push({ date: timestamp, value: valueAtCurrentPrices(), capital: Number(activeSummary.netDeposits) });
    }
    return points;
  }, [activeSummary.cashValue, activeSummary.netDeposits, holdings, intradayBySecurity]);
  const history = useMemo(() => {
    if (range === "1D") return trailingHours(intradayHistory, 24);
    if (range === "1W" && intradayHistory.length > 5) {
      const cutoff = new Date(intradayHistory.at(-1)!.date).getTime() - 7 * 24 * 60 * 60_000;
      return intradayHistory.filter((point) => new Date(point.date).getTime() >= cutoff);
    }
    const all = reconstructedHistory.map((point) => ({ date: point.date, value: Number(point.totalValue), capital: Number(point.investedCapital) }));
    if (range === "CUSTOM" && customRange) return all.filter((point) => {
      const date = point.date.slice(0, 10);
      return date >= customRange.from && date <= customRange.to;
    });
    const latestDate = all.at(-1)?.date.slice(0, 10) ?? todayKey;
    const cutoff = new Date(`${latestDate}T00:00:00Z`);
    if (range === "1W") cutoff.setUTCDate(cutoff.getUTCDate() - 7);
    if (range === "1M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
    if (range === "3M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
    if (range === "YTD") cutoff.setUTCMonth(0, 1);
    return range === "ALL" ? all : all.filter((point) => new Date(`${point.date.slice(0, 10)}T00:00:00Z`) >= cutoff);
  }, [customRange, intradayHistory, range, reconstructedHistory, todayKey]);
  const verifiedPortfolioHistory = fxConversionReady && marketReconciliation.valid ? history : [];

  const portfolioDateBounds = useMemo(() => ({
    min: reconstructedHistory[0]?.date.slice(0, 10) ?? visibleTransactions.map((transaction) => transaction.tradeDate.slice(0, 10)).sort()[0] ?? todayKey,
    max: reconstructedHistory.at(-1)?.date.slice(0, 10) ?? todayKey,
  }), [reconstructedHistory, todayKey, visibleTransactions]);

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
    const detailTransactions = (displayCurrency === "NATIVE" ? visibleTransactions : convertedTransactions).filter((transaction) => transaction.securityId === detailSecurityId);
    const rawSecurity = rawSecurityMap.get(detailSecurityId) ?? security;
    const nativeCurrency = rawSecurity.currency ?? (security as { nativeCurrency?: string }).nativeCurrency ?? "JPY";
    const targetCurrency = displayCurrency === "NATIVE" ? nativeCurrency : displayCurrency;
    const convertedSecurity = securityMap.get(detailSecurityId);
    const result = calculateAverageCostPortfolio(detailTransactions, [displayCurrency === "NATIVE" ? rawSecurity : (convertedSecurity ?? security)], applicableCorporateActions);
    const quote = quotes[detailSecurityId] ?? (security as { quote?: RemoteQuote }).quote;
    const currentPrice = displayCurrency === "NATIVE" ? (quote?.price ?? null) : (convertedSecurity?.quote?.price ?? (quote?.price != null ? convertAmount(quote.price, nativeCurrency, targetCurrency, currentUsdJpy) : null) ?? quote?.price ?? null);
    const previousClose = displayCurrency === "NATIVE" ? (quote?.previousRegularClose ?? null) : (convertedSecurity?.quote?.previousRegularClose ?? (quote?.previousRegularClose != null ? convertAmount(quote.previousRegularClose, nativeCurrency, targetCurrency, previousUsdJpy) : null) ?? quote?.previousRegularClose ?? null);
    const dayDiff = currentPrice != null && previousClose != null ? new Decimal(currentPrice).minus(previousClose).toString() : null;
    return {
      securityId: detailSecurityId,
      quantity: "0",
      totalCost: "0",
      averageCost: "0",
      currentPrice,
      marketValue: "0",
      unrealizedGain: "0",
      realizedGain: result.realizedGain ?? "0",
      dayGain: dayDiff ?? "0",
      security: {
        ...security,
        currency: targetCurrency,
        nativeCurrency,
        quote: convertedSecurity?.quote ?? (quote ? {
          ...quote,
          price: currentPrice ?? quote.price,
          ...(previousClose != null ? { previousRegularClose: previousClose } : {}),
        } : undefined),
      },
    };
  }, [allSecurities, applicableCorporateActions, convertedTransactions, currentUsdJpy, customSecurities, detailSecurityId, displayCurrency, holdings, previousUsdJpy, quotes, rawSecurityMap, securityMap, seed.securities, visibleTransactions, watchlist]);
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
  const acknowledgeSplits = () => {
    const next = [...new Set([...acknowledgedActionIds, ...pendingSplitActions.map((action) => action.id)])];
    setAcknowledgedActionIds(next);
  };
  const markNotificationRead = useCallback((notificationId: string) => {
    const next = [...new Set([...readNotificationIds, notificationId])];
    setReadNotificationIds(next);
  }, [readNotificationIds]);
  const markNotificationsRead = useCallback((notificationIds: string[]) => {
    const next = [...new Set([...readNotificationIds, ...notificationIds])];
    setReadNotificationIds(next);
  }, [readNotificationIds]);
  const securitySuggestions = useMemo(() => {
    const query = securityQuery.trim().toLowerCase();
    if (!query) return [];
    const catalog = searchKnownJapanFunds(query);
    const local = [...rawSecurityMap.values()].filter((security) => `${security.displaySymbol} ${security.name} ${security.legalName}`.toLowerCase().includes(query));
    return [...new Map([...catalog, ...local, ...remoteSecurityResults].map((security) => [security.id, security])).values()].slice(0, 8);
  }, [rawSecurityMap, remoteSecurityResults, securityQuery]);
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
    setSecurityQuery("");
    setRemoteSecurityResults([]);
    setCustomBroker("");
  }, []);

  const openNewTrade = useCallback(() => {
    setEditingTransaction(null);
    setTradeType("BUY");
    setTradeDate(localDateInputValue());
    setTradeQuantity("");
    setTradePrice("");
    setSecurityQuery("");
    setRemoteSecurityResults([]);
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
    setSecurityQuery("");
    setRemoteSecurityResults([]);
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
    const marketTask = Promise.all([
      loadQuotes(isForced, isForced ? "full" : "incremental"),
      loadBenchmarks(isForced),
    ]);
    const refreshTask = (["overview", "watchlist", "performance", "security", "notifications"].includes(activeViewRef.current)
      ? marketTask.then(() => loadHistory(isForced))
      : marketTask)
      .then(() => {
        showToast("市場データを更新しました");
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
  }, [loadBenchmarks, loadHistory, loadQuotes, showToast]);

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
    setHistoryRequested(false);
    setQuoteRefreshToken((current) => current + 1);
    navigateToView("security", false);
  }, [navigateToView]);

  const closeSecurity = useCallback(() => {
    const target = detailReturnViewRef.current === "security" ? "overview" : detailReturnViewRef.current;
    navigateToView(target);
  }, [navigateToView]);

  const openNotificationSecurity = useCallback((securityId: string) => {
    setBrokerFilter("ALL");
    setMarketFilter("ALL");
    openSecurity(securityId, "notifications");
  }, [openSecurity]);

  const openOverviewSecurity = useCallback((securityId: string) => {
    openSecurity(securityId, "overview");
  }, [openSecurity]);

  const openWatchlistSecurity = useCallback((security: SearchSecurity | string) => {
    openSecurity(security, "watchlist");
  }, [openSecurity]);

  const handleAddWatchlist = useCallback((security: SearchSecurity) => {
    setWatchlist((current) => {
      if (current.some((item) => item.id === security.id)) return current;
      return [...current, security];
    });
    if (!allSecurities.some((item) => item.id === security.id)) {
      const next = [...customSecurities, security];
      setCustomSecurities(next);
      void onSecuritiesChange?.([...seed.securities, ...next]);
    }
    setQuoteRefreshToken((current) => current + 1);
  }, [allSecurities, customSecurities, onSecuritiesChange, seed.securities]);

  const handleRemoveWatchlist = useCallback((securityId: string) => {
    setWatchlist((current) => current.filter((item) => item.id !== securityId));
  }, []);

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
    setSecurityQuery("");
    setRemoteSecurityResults([]);
  }, [activeAccounts, allSecurities, customSecurities, onSecuritiesChange, seed.securities, selectedAccountId]);

  const handleOpenTradeForSecurity = useCallback((security: SearchSecurity) => {
    selectTradeSecurity(security);
    setTradeOpen(true);
  }, [selectTradeSecurity]);

  const handleSecuritySearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setSecurityQuery("");
      setRemoteSecurityResults([]);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (securitySuggestions.length) selectTradeSecurity(securitySuggestions[Math.min(securitySuggestionIndex, securitySuggestions.length - 1)]);
      return;
    }
    if (!securitySuggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSecuritySuggestionIndex((current) => (current + 1) % securitySuggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSecuritySuggestionIndex((current) => (current - 1 + securitySuggestions.length) % securitySuggestions.length);
    }
  };

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

  const submitTrade = (event: React.FormEvent) => {
    event.preventDefault();
    if (!tradeQuantity || !tradePrice || Number(tradeQuantity) <= 0 || Number(tradePrice) < 0) return;
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
    const amount = new Decimal(tradeQuantity).mul(tradePrice).div(securityPriceUnit(security)).toString();
    const now = new Date().toISOString();
    const recordedTradeDate = tradeDate || now.slice(0, 10);
    const transaction = editingTransaction ? {
      ...editingTransaction,
      accountId: account.id, securityId: security.id, type: tradeType, tradeDate: recordedTradeDate,
      quantity: tradeQuantity, pricePerShare: tradePrice, tradeCurrency: security.currency, grossAmount: amount,
      original: { ...editingTransaction.original, broker: account.broker, nisa: account.accountType === "nisa" ? "Y" : "N", action: tradeType },
      updatedAt: now, version: Number(editingTransaction.version ?? 1) + 1,
    } satisfies Seed["transactions"][number] : {
      id: `trade-${crypto.randomUUID()}`, portfolioId: seed.portfolio.id, accountId: account.id, securityId: security.id,
      type: tradeType, tradeDate: recordedTradeDate, quantity: tradeQuantity, pricePerShare: tradePrice, tradeCurrency: security.currency,
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
    download("kabutora-backup.json", JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), portfolio: seed.portfolio, accounts, securities: allSecurities, transactions }, null, 2), "application/json");
    showToast("バックアップを書き出しました");
  }, [accounts, allSecurities, seed.portfolio, showToast, transactions]);
  const settingsSeed = useMemo(() => ({ ...seed, accounts, securities: allSecurities, transactions }), [accounts, allSecurities, seed, transactions]);
  const markAllNotificationsRead = useCallback(() => markNotificationsRead(portfolioNotifications.map((notice) => notice.id)), [markNotificationsRead, portfolioNotifications]);

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
    const pending: View[] = ["watchlist", "activity", "notifications", "settings"];
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

  if (!hydrated) return <AppLoadingScreen label="表示設定を読み込み中" detail="テーマとポートフォリオ設定を反映しています" />;
  if (!marketStartupReady) return <AppLoadingScreen label="市場データを取得中" detail="保有銘柄の価格と主要指標を更新しています" />;

  return <>
    <div
      ref={appShellRef}
      className="app-shell"
      data-pull-refreshing={isPullRefreshing}
      data-swipe-active="false"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
    >
      <div
        ref={pullBannerRef}
        className="pull-refresh-banner"
        data-visible={isPullRefreshing ? "true" : "false"}
        data-ready="false"
        data-refreshing={isPullRefreshing ? "true" : "false"}
        role="status"
        aria-live="polite"
        aria-hidden={!isPullRefreshing}
      >
        <div className="pull-refresh-pill">
          <RefreshCw
            ref={pullIconRef}
            size={18}
            className={isPullRefreshing ? "spin" : ""}
          />
          <span ref={pullTextRef}>
            {isPullRefreshing ? "市場データを更新中…" : "引いて更新"}
          </span>
        </div>
      </div>
      <header className="app-header">
        <Brand />
        <nav className="desktop-nav" aria-label="メインナビゲーション">
          {NAV_ITEMS.map((item) => {
            const active = view === item.id || (view === "security" && item.id === detailReturnView);
            return (
              <button
                key={item.id}
                className={active ? "active" : ""}
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
            <label className="broker-filter" title="証券会社で保有銘柄と取引履歴を絞り込み"><span>証券会社</span><select aria-label="証券会社で絞り込み" value={brokerFilter} onChange={(event) => setBrokerFilter(event.target.value)}><option value="ALL">全口座</option>{brokerOptions.map((broker) => <option key={broker} value={broker}>{broker.replace("証券", "")}</option>)}</select></label>
            <label className="market-filter" title="資産区分と個別株の国でポートフォリオを絞り込み"><span>資産区分</span><select aria-label="資産区分と国で絞り込み" value={marketFilter} onChange={(event) => handleMarketFilterChange(event.target.value as PortfolioFilter)}><option value="ALL">全資産</option><option value="JP">日本株</option><option value="US">米国株</option><option value="FUNDS_INDEXES">投信・指数</option></select></label>
            <label className="currency-filter" title="表示通貨"><span>表示通貨</span><select aria-label="表示通貨" value={displayCurrency} onChange={(event) => setDisplayCurrency(event.target.value as DisplayCurrency)}><option value="JPY">JPY</option><option value="USD">USD</option><option value="NATIVE">現地通貨</option></select></label>
          </div>
          <div className="header-tools">
            <button className="icon-button" onClick={() => setSummaryAmountsVisible((v) => !v)} aria-label={summaryAmountsVisible ? "金額を非表示" : "金額を表示"} title={summaryAmountsVisible ? "金額を非表示" : "金額を表示"}>{summaryAmountsVisible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
            <button className="icon-button" onClick={() => refreshMarket(true)} aria-label="市場データを更新"><RefreshCw size={17} /></button>
            <button className="icon-button" onClick={() => setDark((value) => !value)} aria-label="テーマを切り替え">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
            <button className="trade-button" aria-label="取引を記録" onClick={openNewTrade}><Plus size={16} /><span>取引</span></button>
          </div>
        </div>
      </header>

      <main
        ref={workspaceRef}
        className="workspace"
      >
        {mountedViews.has("activity") && <div className={`view-cache ${renderedView === "activity" ? "active" : ""}`} style={{ display: renderedView === "activity" ? "block" : "none" }}>
          <FastActivityView transactions={calculationTransactions} securityMap={rawSecurityMap} accountMap={accountMap} corporateActions={applicableCorporateActions} brokerOptions={brokerOptions} onEdit={requestTransactionEdit} onDelete={requestTransactionDelete} onOpenTrade={openNewTrade} />
        </div>}
        {mountedViews.has("overview") && <div className={`view-cache ${renderedView === "overview" ? "active" : ""}`} style={{ display: renderedView === "overview" ? "block" : "none" }}>
          <FastOverview
            totalValue={totalValue} dayGain={dayGain} dayReturn={dayReturn}
            summary={activeSummary} totalGain={totalGain} totalReturn={totalReturn} holdings={holdings} history={verifiedPortfolioHistory} historyStatus={historyStatus}
            quoteStatus={quoteStatus} marketSessions={marketSessions} marketError={marketError} historyError={historyError} dataReconciled={marketReconciliation.valid} benchmarks={benchmarks} benchmarkStatus={benchmarkStatus}
            valuationComplete={valuationComplete} range={range} setRange={setRange} intradayBySecurity={intradayBySecurity} refreshMarket={refreshMarket}
            dailyHistoryBySecurity={dailyHistoryBySecurity} marketFilter={marketFilter} setMarketFilter={handleMarketFilterChange} brokerFilter={brokerFilter} setBrokerFilter={setBrokerFilter} brokerOptions={brokerOptions} setDisplayCurrency={setDisplayCurrency} amountsVisible={summaryAmountsVisible} setAmountsVisible={setSummaryAmountsVisible}
            customRange={customRange} setCustomRange={setCustomRange} dateBounds={portfolioDateBounds}
            onSelectSecurity={openOverviewSecurity} currency={displayCurrency} summaryCurrency={effectiveSummaryCurrency} fxReady={fxConversionReady}
          />
        </div>}
        {mountedViews.has("watchlist") && <div className={`view-cache ${renderedView === "watchlist" ? "active" : ""}`} style={{ display: renderedView === "watchlist" ? "block" : "none" }}>
          <FastWatchlistView
            watchlist={watchlist}
            onAddSecurity={handleAddWatchlist}
            onRemoveSecurity={handleRemoveWatchlist}
            quotes={quotes}
            intradayBySecurity={intradayBySecurity}
            dailyHistoryBySecurity={dailyHistoryBySecurity}
            quoteStatus={quoteStatus}
            marketSessions={marketSessions}
            currency="NATIVE"
            currentUsdJpy={validUsdJpy(currentUsdJpy) ? currentUsdJpy : null}
            onSelectSecurity={openWatchlistSecurity}
            onOpenTrade={handleOpenTradeForSecurity}
            onRefresh={refreshMarket}
            amountsVisible={summaryAmountsVisible}
            allSecurities={allSecurities}
          />
        </div>}
        {mountedViews.has("notifications") && <div className={`view-cache ${renderedView === "notifications" ? "active" : ""}`} style={{ display: renderedView === "notifications" ? "block" : "none" }}>
          <FastNotificationsView notifications={portfolioNotifications} securityMap={rawSecurityMap} detailSecurityIds={allTransactionSecurityIds} readNotificationIds={readNotificationIds} onRead={markNotificationRead} onReadAll={markAllNotificationsRead} onOpenSecurity={openNotificationSecurity} monitoredCount={allTransactionSecurityIds.size} quoteStatus={quoteStatus} historyStatus={historyStatus} latestQuoteAt={latestQuoteAt} externalFeedConnected={seededMarketNotices.length > 0} onRefresh={refreshMarket}/>
        </div>}
        {mountedViews.has("settings") && <div className={`view-cache ${renderedView === "settings" ? "active" : ""}`} style={{ display: renderedView === "settings" ? "block" : "none" }}>
          <FastSettingsView seed={settingsSeed} exportCsv={exportCsv} exportJson={exportJson} onEncryptedBackup={onEncryptedBackup} allowPlaintextExport={allowPlaintextExport} onLock={onLock} onLogout={onLogout} dark={dark} setDark={setDark} accentTheme={accentTheme} setAccentTheme={setAccentTheme} quoteStatus={quoteStatus} benchmarkStatus={benchmarkStatus} historyStatus={historyStatus} historyQuality={historyQuality} historyCacheMeta={historyCacheMeta} quoteHealth={quoteHealth} historyHealth={historyHealth} dataReconciled={marketReconciliation.valid} corporateActionCount={applicableCorporateActions.length} latestQuoteAt={latestQuoteAt} apiUsage={apiUsage} benchmarkCount={benchmarks.length} quoteCount={Object.keys(quotes).length} intradayCount={intradayBars.length} historyCount={historyBars.length} persistenceMode={persistenceMode} allowPersistentMarketCache={allowPersistentMarketCache} serverOrigin={hydrated ? window.location.origin : "—"} autoRefresh={autoRefresh} setAutoRefresh={setAutoRefresh} updateFrequency={updateFrequency} setUpdateFrequency={setUpdateFrequency} effectiveUpdateMinutes={effectiveUpdateMinutes} hideScrollbar={hideScrollbar} setHideScrollbar={setHideScrollbar} displayCurrency={displayCurrency} marketFilter={marketFilter} currentUsdJpy={validUsdJpy(currentUsdJpy) ? currentUsdJpy : null} notificationCount={portfolioNotifications.length} priceAlertThreshold={priceAlertThreshold} setPriceAlertThreshold={setPriceAlertThreshold} />
        </div>}
        {renderedView === "security" && (
          <div className="view-cache active" style={{ display: "block" }}>
            {selectedHolding ? (
              <SecurityDetailView holding={selectedHolding} transactions={(displayCurrency === "NATIVE" ? visibleTransactions : convertedTransactions).filter((transaction) => transaction.securityId === detailSecurityId)} accountMap={accountMap} historyBars={displayCurrency === "NATIVE" ? historyBars : convertedHistoryBars} corporateActions={applicableCorporateActions} historyStatus={historyStatus} onBack={closeSecurity} returnView={detailReturnView} currency={displayCurrency} notifications={portfolioNotifications.filter((notice) => notice.securityId === detailSecurityId)} readNotificationIds={readNotificationIds} onReadNotification={markNotificationRead} onEditTransaction={requestTransactionEdit} onDeleteTransaction={requestTransactionDelete} amountsVisible={summaryAmountsVisible}/>
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

      {tradeOpen && <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeTradeModal()}>
        <form className="trade-modal" onSubmit={submitTrade}>
          <div className="modal-head"><div><span>{editingTransaction ? "EDIT TRADE" : "NEW TRADE"}</span><h2>{editingTransaction ? "取引を編集" : "取引を記録"}</h2></div><button type="button" className="icon-button" onClick={closeTradeModal} aria-label="閉じる"><X size={18} /></button></div>
          <div className="segmented big"><button type="button" className={tradeType === "BUY" ? "active" : ""} onClick={() => setTradeType("BUY")}>買付</button><button type="button" className={tradeType === "SELL" ? "active" : ""} onClick={() => setTradeType("SELL")}>売却</button></div>
          <div className="security-search-field">
            <label htmlFor="security-search">銘柄検索</label>
            <div className="security-search-input">
              <Search size={14}/>
              <input
                id="security-search"
                role="combobox"
                aria-expanded={Boolean(securityQuery)}
                aria-controls="security-suggestions"
                aria-autocomplete="list"
                aria-activedescendant={securityQuery && securitySuggestions.length ? `security-option-${securitySuggestionIndex}` : undefined}
                autoComplete="off"
                value={securityQuery}
                onChange={(event) => { setSecurityQuery(event.target.value); setSecuritySuggestionIndex(0); }}
                onKeyDown={handleSecuritySearchKeyDown}
                placeholder="名前・コード・ティッカー"
              />
              {securityQuery && <button type="button" className="security-search-clear" aria-label="検索をクリア" onClick={() => { setSecurityQuery(""); setRemoteSecurityResults([]); }}><X size={13}/></button>}
            </div>
            {selectedTradeSecurity && !securityQuery && <div className="selected-security" aria-live="polite"><i/><div><strong>{selectedTradeSecurity.name}</strong><span>{selectedTradeSecurity.displaySymbol} · {marketDisplayName(selectedTradeSecurity)} · {selectedTradeSecurity.currency}</span></div><small>選択中</small></div>}
            {securityQuery && <div className="security-suggestions" id="security-suggestions" role="listbox" aria-label="銘柄候補">
              {securitySuggestions.map((security, index) => <button type="button" id={`security-option-${index}`} role="option" aria-selected={index === securitySuggestionIndex} key={security.id} onMouseEnter={() => setSecuritySuggestionIndex(index)} onClick={() => selectTradeSecurity(security)}><div><strong>{security.name}</strong><span>{security.displaySymbol} · {security.exchangeLabel ?? security.exchangeMic} · {security.currency}</span></div></button>)}
              {securitySearchStatus === "loading" && <div className="suggestion-state"><RefreshCw size={12} className="spin"/>検索中</div>}
              {securitySearchStatus === "error" && !securitySuggestions.length && <div className="suggestion-state">検索できませんでした</div>}
              {securitySearchStatus === "ready" && !securitySuggestions.length && <div className="suggestion-state">一致する銘柄がありません</div>}
            </div>}
          </div>
          <div className="brokerage-select-row"><label className="brokerage-field">証券口座<select value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)} required>{selectableAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.archivedAt ? "（削除済み）" : ""}</option>)}<option value="__custom__">その他の証券会社を追加…</option></select></label><button type="button" className="remove-account-button" aria-label="選択中の証券口座を一覧から削除" title="この口座を一覧から削除" disabled={selectedAccountId === "__custom__" || !accountMap.get(selectedAccountId) || Boolean(accountMap.get(selectedAccountId)?.archivedAt) || accountMap.get(selectedAccountId)?.broker === "現金口座"} onClick={() => setPendingRemoveAccountId(selectedAccountId)}><Trash2 size={16}/></button></div>
          {selectedAccountId === "__custom__" && <label className="custom-broker-field">証券会社名<input value={customBroker} onChange={(event) => setCustomBroker(event.target.value)} placeholder="例: 楽天証券" autoFocus required /></label>}
          <div className="form-grid trade-fields"><label>取引日<input type="date" value={tradeDate} max={localDateInputValue()} onChange={(event) => setTradeDate(event.target.value)} required /></label><label>{isFundSecurity(selectedTradeSecurity) ? "口数" : "数量"}<input inputMode="decimal" value={tradeQuantity} onChange={(event) => setTradeQuantity(event.target.value)} placeholder={isFundSecurity(selectedTradeSecurity) ? securityPriceUnit(selectedTradeSecurity) === 10_000 ? "10000" : "1" : isIndexSecurity(selectedTradeSecurity) ? "1" : "100"} required /></label><label>{isFundSecurity(selectedTradeSecurity) ? `基準価額（${securityPriceBasis(selectedTradeSecurity)}・${selectedTradeSecurity?.currency ?? "JPY"}）` : isIndexSecurity(selectedTradeSecurity) ? `指数値（${selectedTradeSecurity?.currency ?? "USD"}）` : `価格（${selectedTradeSecurity?.currency ?? "JPY"}）`}<input inputMode="decimal" value={tradePrice} onChange={(event) => setTradePrice(event.target.value)} placeholder={isFundSecurity(selectedTradeSecurity) ? securityPriceUnit(selectedTradeSecurity) === 10_000 ? "16,000" : "900.00" : isIndexSecurity(selectedTradeSecurity) ? "5,000" : "3,658"} required /></label></div>
          <div className="trade-preview"><span>概算金額</span><strong>{money(Number(tradeQuantity || 0) * Number(tradePrice || 0) / securityPriceUnit(selectedTradeSecurity), selectedTradeSecurity?.currency)}</strong></div>
          <button className="trade-button full" type="submit" disabled={Boolean(securityQuery.trim()) || !selectedTradeSecurity || (selectedAccountId === "__custom__" && !customBroker.trim())}>{securityQuery.trim() ? "候補から銘柄を選択" : editingTransaction ? persistenceMode === "cloud" ? "変更を保存して同期" : "変更を端末に保存" : persistenceMode === "cloud" ? "保存して同期" : "端末に保存"}</button>
          <p className="privacy-note"><ShieldCheck size={14} /> {persistenceMode === "cloud" ? `取引${editingTransaction ? "の変更" : "と証券口座"}は暗号化され、同じアカウントの端末へ同期されます。` : "同期設定前はこの端末内だけに保存されます。"}</p>
        </form>
      </div>}
      {pendingDeleteTransaction && <div className="modal-layer delete-confirm-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPendingDeleteTransaction(null)}>
        <section className="delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-transaction-title" aria-describedby="delete-transaction-warning">
          <div className="delete-confirm-heading"><span className="delete-confirm-icon"><AlertTriangle size={21}/></span><div><small>取引履歴から削除</small><h2 id="delete-transaction-title">この取引を削除しますか？</h2></div></div>
          <p id="delete-transaction-warning">削除すると、保有数・平均取得単価・実現損益・パフォーマンス履歴が再計算され、同じアカウントのMacとiPhoneにも反映されます。</p>
          <dl className="delete-transaction-facts">
            <div><dt>取引</dt><dd>{pendingDeleteTransaction.type === "BUY" ? "買付" : pendingDeleteTransaction.type === "SELL" ? "売却" : pendingDeleteTransaction.type}</dd></div>
            <div><dt>取引日</dt><dd>{dateJa(pendingDeleteTransaction.tradeDate)}</dd></div>
            <div><dt>銘柄</dt><dd>{pendingDeleteTransaction.securityId ? `${rawSecurityMap.get(pendingDeleteTransaction.securityId)?.name ?? "不明な銘柄"} · ${rawSecurityMap.get(pendingDeleteTransaction.securityId)?.displaySymbol ?? "—"}` : "現金"}</dd></div>
            <div><dt>証券口座</dt><dd>{accountMap.get(pendingDeleteTransaction.accountId)?.name ?? "口座未設定"}</dd></div>
            <div><dt>数量</dt><dd>{pendingDeleteTransaction.quantity ? `${number.format(Math.abs(Number(pendingDeleteTransaction.quantity)))}${securityQuantityUnit(rawSecurityMap.get(pendingDeleteTransaction.securityId ?? ""))}` : "—"}</dd></div>
            <div><dt>約定単価</dt><dd>{pendingDeleteTransaction.pricePerShare != null ? maybeMoney(pendingDeleteTransaction.pricePerShare, pendingDeleteTransaction.tradeCurrency ?? "JPY") : "—"}</dd></div>
            <div className="delete-transaction-total"><dt>約定金額</dt><dd>{maybeMoney(pendingDeleteTransaction.grossAmount, pendingDeleteTransaction.tradeCurrency ?? "JPY")}</dd></div>
          </dl>
          <strong className="delete-warning">この操作は元に戻せません。</strong>
          <div className="delete-confirm-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setPendingDeleteTransaction(null)}>キャンセル</button><button type="button" className="danger-button" onClick={confirmTransactionDelete}><Trash2 size={15}/>削除する</button></div>
        </section>
      </div>}
      {pendingRemoveAccountId && accountMap.get(pendingRemoveAccountId) && <div className="modal-layer delete-confirm-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPendingRemoveAccountId(null)}>
        <section className="delete-confirm account-remove-confirm" role="alertdialog" aria-modal="true" aria-labelledby="remove-account-title" aria-describedby="remove-account-warning">
          <div className="delete-confirm-heading"><span className="delete-confirm-icon"><AlertTriangle size={21}/></span><div><small>取引口座一覧から削除</small><h2 id="remove-account-title">この証券口座を削除しますか？</h2></div></div>
          <p id="remove-account-warning">{transactions.some((transaction) => transaction.accountId === pendingRemoveAccountId) ? "この口座を使った過去の取引があります。今後の取引候補からは削除しますが、FIFO損益と履歴を正しく保つため、過去取引の口座情報は保持されます。" : "この口座は取引候補から削除され、同じGoogleアカウントのMacとiPhoneにも同期されます。"}</p>
          <dl className="delete-transaction-facts">
            <div><dt>証券口座</dt><dd>{accountMap.get(pendingRemoveAccountId)?.name}</dd></div>
            <div><dt>証券会社</dt><dd>{accountMap.get(pendingRemoveAccountId)?.broker}</dd></div>
            <div><dt>口座種別</dt><dd>{accountMap.get(pendingRemoveAccountId)?.accountType === "nisa" ? "NISA" : accountMap.get(pendingRemoveAccountId)?.accountType === "taxable" ? "課税口座" : accountMap.get(pendingRemoveAccountId)?.accountType}</dd></div>
            <div><dt>関連取引</dt><dd>{transactions.filter((transaction) => transaction.accountId === pendingRemoveAccountId).length}件</dd></div>
          </dl>
          <div className="delete-confirm-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setPendingRemoveAccountId(null)}>キャンセル</button><button type="button" className="danger-button" onClick={confirmAccountRemoval}><Trash2 size={15}/>一覧から削除</button></div>
        </section>
      </div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
    {startupCoverVisible && <AppLoadingScreen exiting={startupCoverExiting} label="画面を仕上げています" detail="最新データを表示する準備ができました" />}
  </>;
}

function MarketSessionIndicator({ sessions, quoteStatus }: { sessions: MarketSessionStatus[]; quoteStatus: MarketStatus }) {
  if (!sessions.length) {
    return (
      <span className="session-group" aria-label="日本・米国市場の取引セッション">
        {(["JP", "US"] as const).map((market) => (
          <small key={market} className="session-inline loading">
            <i className="session-dot" aria-hidden="true" />
            <span className="session-copy">
              <b className="session-market">{market}</b>{" "}
              <span className="session-status">{quoteStatus === "loading" ? "判定中" : "不明"}</span>
            </span>
          </small>
        ))}
      </span>
    );
  }
  return (
    <span className="session-group" aria-label="市場の取引セッション">
      {sessions.map((status) => {
        const compactLabel =
          status.session === "regular"
            ? "取引中"
            : status.session === "pre_market"
            ? "プレ"
            : status.session === "after_hours"
            ? "時間外"
            : status.session === "pts_day"
            ? "PTS日中"
            : status.session === "pts_night"
            ? "PTS夜間"
            : status.session === "closed"
            ? "休場"
            : "不明";
        const isOpen = Boolean(status.isOpen);
        return (
          <small
            key={status.market}
            className={`session-inline ${isOpen ? "open" : "closed"}`}
            title={`${status.marketLabel}: ${status.label} · ${status.detail} · カレンダー: ${status.calendarSource === "official" ? "取引所公表済み" : "取引所規則による推定"}`}
          >
            <i className="session-dot" aria-hidden="true" />
            <span className="session-copy">
              <b className="session-market">{status.market}</b>{" "}
              <span className="session-status">{compactLabel}</span>
            </span>
          </small>
        );
      })}
    </span>
  );
}

function Overview({ totalValue, dayGain, dayReturn, summary, totalGain, totalReturn, holdings, history, historyStatus, quoteStatus, marketSessions, marketError, historyError, dataReconciled, benchmarks, benchmarkStatus, valuationComplete, range, setRange, customRange, setCustomRange, dateBounds, intradayBySecurity, dailyHistoryBySecurity, marketFilter, setMarketFilter, brokerFilter, setBrokerFilter, brokerOptions = [], setDisplayCurrency, refreshMarket, onSelectSecurity, currency, summaryCurrency, fxReady, amountsVisible, setAmountsVisible }: any) {
  const [isExpanded, setIsExpanded] = useState(false);
  const dataError = !dataReconciled ? "日米の集計が一致しないため数値を非表示にしました" : historyError || marketError;
  const activeSummaryCurrency = summaryCurrency ?? (currency === "NATIVE" ? "JPY" : currency);
  const allocationCash = Number(summary.cashValue ?? 0);

  return <div className={`overview-page ${isExpanded ? "chart-expanded" : ""}`}>
    {(!fxReady || dataError || summary.unpricedSecurityCount > 0) && (
      <div className="market-alert" role="status">
        <AlertTriangle size={15} />
        <span>{!fxReady ? "通貨換算レートを取得中" : dataError || `${summary.unpricedSecurityCount}銘柄が未評価`}</span>
        <button
          type="button"
          onClick={() => {
            void refreshMarket(true);
          }}
        >
          再試行
        </button>
      </div>
    )}
    <div className="market-overview-strip">
      <div className="market-session-panel"><MarketSessionIndicator sessions={marketSessions as MarketSessionStatus[]} quoteStatus={quoteStatus}/></div>
      <FastFxRates benchmarks={benchmarks} status={benchmarkStatus}/>
      <FastMarketTape benchmarks={benchmarks} status={benchmarkStatus}/>
    </div>

    <section className="daily-grid" aria-label="ポートフォリオサマリー">
      <div className="daily-summary">
        <div className="daily-summary-main">
          <div className="daily-stat-item primary">
            <span className="daily-stat-label">総評価</span>
            <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "金額非表示"}>
              {amountsVisible ? maybeMoney(totalValue, activeSummaryCurrency) : HIDDEN_AMOUNT}
            </strong>
          </div>
          <div className="daily-stat-item">
            <span className="daily-stat-label">本日</span>
            <div className="daily-stat-inline">
              <strong className={`daily-stat-val ${Number(dayGain ?? 0) >= 0 ? "up" : "down"}`}>
                {signedPercent(dayReturn)}
              </strong>
              <small className={`daily-stat-sub ${Number(dayGain ?? 0) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                ({amountsVisible ? formatDayGainMoney(Number(dayGain ?? 0), activeSummaryCurrency) : HIDDEN_AMOUNT})
              </small>
            </div>
          </div>
        </div>
        <div className="daily-summary-divider" aria-hidden="true"/>
        <div className="daily-summary-metrics">
          <div className="daily-stat-item">
            <span className="daily-stat-label">含み損益</span>
            <div className="daily-stat-inline">
              <strong className={`daily-stat-val ${Number(summary.unrealizedGain) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                {amountsVisible ? (valuationComplete ? compactMoney(Number(summary.unrealizedGain), activeSummaryCurrency, true) : "—") : HIDDEN_AMOUNT}
              </strong>
              {valuationComplete && Number(summary.costBasis) > 0 && <small className={`daily-stat-sub ${Number(summary.unrealizedGain) >= 0 ? "up" : "down"}`}>
                ({signedPercent(Number(summary.unrealizedGain) / Number(summary.costBasis))})
              </small>}
            </div>
          </div>
          <div className="daily-stat-item">
            <span className="daily-stat-label">確定損益</span>
            <strong className={`daily-stat-val ${Number(summary.realizedGain) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
              {amountsVisible ? compactMoney(Number(summary.realizedGain), activeSummaryCurrency, true) : HIDDEN_AMOUNT}
            </strong>
          </div>
          <div className="daily-stat-item">
            <span className="daily-stat-label">通算損益</span>
            <div className="daily-stat-inline">
              <strong className={`daily-stat-val ${Number(totalGain ?? 0) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                {amountsVisible ? (valuationComplete ? compactMoney(Number(totalGain), activeSummaryCurrency, true) : "—") : HIDDEN_AMOUNT}
              </strong>
              <small className={`daily-stat-sub ${Number(totalReturn ?? 0) >= 0 ? "up" : "down"}`}>
                ({signedPercent(totalReturn)})
              </small>
            </div>
          </div>
        </div>
      </div>

      <div className={`daily-performance ${isExpanded ? "expanded" : ""}`} data-swipe-ignore="true">
        <div className="daily-performance-toolbar">
          <div className="daily-range chart-range-menu">
            <div className="chart-range-presets segmented" aria-label="表示期間">
              {PORTFOLIO_RANGES.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={range === item ? "active" : ""}
                  onClick={() => setRange(item)}
                >
                  {rangeLabel(item)}
                </button>
              ))}
            </div>
            <DateRangeControl
              value={customRange}
              active={range === "CUSTOM"}
              min={dateBounds.min}
              max={dateBounds.max}
              onApply={(next: CustomDateRange) => {
                setCustomRange(next);
                setRange("CUSTOM");
              }}
            />
          </div>
        </div>

        {isExpanded ? (
          <div className="daily-expanded-body" data-swipe-ignore="true">
            <div className="daily-chart expanded" data-swipe-ignore="true">
              <PortfolioChart
                history={history}
                historyStatus={historyStatus}
                zeroBased={range === "ALL"}
                showCapital={range !== "1D" && range !== "1W"}
                currency={activeSummaryCurrency}
                amountsVisible={amountsVisible}
                detailsEnabled
              />
            </div>
            <div className="daily-allocation-divider" />
            <AllocationChart
              holdings={holdings}
              cashValue={allocationCash}
              currency={activeSummaryCurrency}
              amountsVisible={amountsVisible}
            />
            <div className="daily-expanded-floating-close" data-swipe-ignore="true">
              <button
                type="button"
                className="daily-expanded-close-bar"
                onClick={() => setIsExpanded(false)}
                aria-label="閉じる"
              >
                <X size={16} />
                <span>閉じる</span>
              </button>
            </div>
          </div>
        ) : (
          <div
            className="daily-chart clickable"
            data-swipe-ignore="true"
            onClick={() => setIsExpanded(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setIsExpanded(true);
              }
            }}
            aria-label="クリックしてチャートを拡大"
            title="クリックしてチャートを拡大"
          >
            <PortfolioChart
              history={history}
              historyStatus={historyStatus}
              zeroBased={range === "ALL"}
              showCapital={range !== "1D" && range !== "1W"}
              compact
              currency={activeSummaryCurrency}
              amountsVisible={amountsVisible}
            />
          </div>
        )}
      </div>

      {!isExpanded && (
        <section className="daily-holdings" aria-label={`保有銘柄 ${holdings.length}件`}>
          <HoldingsTable
            holdings={holdings}
            totalValue={totalValue}
            intradayBySecurity={intradayBySecurity}
            dailyHistoryBySecurity={dailyHistoryBySecurity}
            marketFilter={marketFilter}
            dense
            onSelect={onSelectSecurity}
            currency={currency}
            amountsVisible={amountsVisible}
          />
        </section>
      )}

      {/* Floating Bottom Controls Dock matching search/watchlist and notifications */}
      <div className="overview-bottom-controls" data-swipe-ignore="true">
        <div className="overview-filters" role="group" aria-label="ポートフォリオ表示フィルター">
          <select
            aria-label="証券会社で絞り込み"
            className="overview-filter-select"
            value={brokerFilter}
            onChange={(event) => setBrokerFilter(event.target.value)}
          >
            <option value="ALL">全口座</option>
            {brokerOptions.map((broker: string) => (
              <option key={broker} value={broker}>{broker.replace("証券", "")}</option>
            ))}
          </select>
          <select
            aria-label="資産区分で絞り込み"
            className="overview-filter-select"
            value={marketFilter}
            onChange={(event) => setMarketFilter(event.target.value as PortfolioFilter)}
          >
            <option value="ALL">全資産</option>
            <option value="JP">日本株</option>
            <option value="US">米国株</option>
            <option value="FUNDS_INDEXES">投信・指数</option>
          </select>
          <select
            aria-label="表示通貨"
            className="overview-filter-select"
            value={currency}
            onChange={(event) => setDisplayCurrency(event.target.value as DisplayCurrency)}
          >
            <option value="JPY">JPY</option>
            <option value="USD">USD</option>
            <option value="NATIVE">現地通貨</option>
          </select>
        </div>
        <button
          type="button"
          className="trade-button overview-visibility-toggle-btn"
          aria-label={amountsVisible ? "金額を非表示" : "金額を表示"}
          title={amountsVisible ? "金額を非表示" : "金額を表示"}
          onClick={() => setAmountsVisible(!amountsVisible)}
        >
          {amountsVisible ? <Eye size={18} /> : <EyeOff size={18} />}
        </button>
      </div>
    </section>
  </div>;
}

function FxRates({ benchmarks, status }: { benchmarks: Benchmark[]; status: MarketStatus }) {
  const ordered = ["usd-jpy", "cny-jpy"].map((id) => benchmarks.find((item) => item.id === id)).filter(Boolean) as Benchmark[];
  return <section className={`market-fx-panel${ordered.length ? "" : " loading"}`} aria-label="為替レート">
    {ordered.length ? ordered.map((item) => <span className="market-fx-item" key={item.id}><small>{item.label}</small><strong>{fxNumber.format(item.value)}</strong></span>) : <span>{status === "loading" ? "FX取得中" : "FX —"}</span>}
  </section>;
}

function MarketTape({ benchmarks, status }: { benchmarks: Benchmark[]; status: MarketStatus }) {
  const ordered = ["sp500", "nasdaq", "dow", "nikkei225", "topix"].map((id) => benchmarks.find((item) => item.id === id)).filter(Boolean) as Benchmark[];
  if (!ordered.length) return <section className="market-tape loading" aria-label="主要市場指標"><span>{status === "loading" ? "主要指標を取得中…" : "主要指標は現在取得できません"}</span></section>;
  const tapeSet = (copy: number) => (
    <div className="market-tape-set" aria-hidden={copy > 0 || undefined} key={`tape-${copy}`}>
      {ordered.map((item) => (
        <div className="market-tape-item" key={`${copy}-${item.id}`}>
          <span className="market-tape-name">{item.label}</span>
          <div className="market-tape-data">
            <strong>{benchmarkNumber.format(item.value)}</strong>
            <small className={Number(item.changeRatio ?? 0) >= 0 ? "up" : "down"}>{signedPercent(item.changeRatio)}</small>
          </div>
        </div>
      ))}
    </div>
  );
  return <section className="market-tape" aria-label="主要市場指標" tabIndex={0}><div className="market-tape-track">{[0, 1, 2, 3].map(tapeSet)}</div></section>;
}

function InlineMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div><dt>{label}</dt><dd className={tone}>{value}</dd></div>;
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return <article><span>{label}</span><strong className={tone}>{value}</strong>{sub && <small className={tone}>{sub}</small>}</article>;
}

export type HoldingsSort =
  | "VALUE_DESC"
  | "DAY_DESC"
  | "GAIN_DESC"
  | "DAY_GAIN_VALUE_DESC"
  | "PRICE_DESC"
  | "NAME_ASC";

function HoldingsTable({ holdings, totalValue, intradayBySecurity, dailyHistoryBySecurity, marketFilter = "ALL", dense = false, onSelect, currency, amountsVisible = true }: any) {
  const [sortBy, setSortBy] = useState<HoldingsSort>(() => {
    if (typeof window === "undefined") return "VALUE_DESC";
    try {
      const saved = localStorage.getItem("kabutora-holdings-sort") as HoldingsSort | null;
      if (saved && ["VALUE_DESC", "DAY_DESC", "GAIN_DESC", "DAY_GAIN_VALUE_DESC", "PRICE_DESC", "NAME_ASC"].includes(saved)) {
        return saved;
      }
    } catch {}
    return "VALUE_DESC";
  });

  useEffect(() => {
    try {
      localStorage.setItem("kabutora-holdings-sort", sortBy);
    } catch {}
  }, [sortBy]);

  const sortedHoldings = useMemo(() => {
    const list = [...holdings];
    return list.sort((a: any, b: any) => {
      const aVal = a.marketValue == null ? -Infinity : Number(a.marketValue);
      const bVal = b.marketValue == null ? -Infinity : Number(b.marketValue);

      const aQuote = a.security?.quote as RemoteQuote | undefined;
      const bQuote = b.security?.quote as RemoteQuote | undefined;

      const aPrice = a.currentPrice == null ? null : Number(a.currentPrice);
      const bPrice = b.currentPrice == null ? null : Number(b.currentPrice);

      const aPrev = aQuote?.previousRegularClose == null ? null : Number(aQuote.previousRegularClose);
      const bPrev = bQuote?.previousRegularClose == null ? null : Number(bQuote.previousRegularClose);

      const aDayPct = aPrice != null && aPrev ? aPrice / aPrev - 1 : (a.dayGain == null ? -Infinity : Number(a.dayGain));
      const bDayPct = bPrice != null && bPrev ? bPrice / bPrev - 1 : (b.dayGain == null ? -Infinity : Number(b.dayGain));

      const aDayGain = a.dayGain == null ? -Infinity : Number(a.dayGain);
      const bDayGain = b.dayGain == null ? -Infinity : Number(b.dayGain);

      const aCost = Number(a.totalCost || 0);
      const bCost = Number(b.totalCost || 0);

      const aGainPct = a.unrealizedGain != null && aCost ? Number(a.unrealizedGain) / aCost : -Infinity;
      const bGainPct = b.unrealizedGain != null && bCost ? Number(b.unrealizedGain) / bCost : -Infinity;

      switch (sortBy) {
        case "VALUE_DESC":
          return bVal - aVal;
        case "DAY_DESC":
          return bDayPct - aDayPct;
        case "GAIN_DESC":
          return bGainPct - aGainPct;
        case "DAY_GAIN_VALUE_DESC":
          return bDayGain - aDayGain;
        case "PRICE_DESC":
          return (bPrice ?? -Infinity) - (aPrice ?? -Infinity);
        case "NAME_ASC":
          return (a.security?.name || a.security?.symbol || "").localeCompare(b.security?.name || b.security?.symbol || "", "ja");
        default:
          return bVal - aVal;
      }
    });
  }, [holdings, sortBy]);

  const sortIndicator = (key: HoldingsSort) => {
    if (sortBy === key) return <span className="sort-arrow active" aria-hidden="true">↓</span>;
    return null;
  };

  return <div className={`holdings-table ${dense ? "dense" : ""}`}>
    <div className="holdings-mobile-header" role="row">
      <button type="button" className={`mobile-sort-btn ${sortBy === "NAME_ASC" ? "active" : ""}`} onClick={() => setSortBy("NAME_ASC")}>
        銘柄 {sortIndicator("NAME_ASC")}
      </button>
      <span className="mobile-header-label">推移</span>
      <button type="button" className={`mobile-sort-btn right ${sortBy === "DAY_DESC" ? "active" : ""}`} onClick={() => setSortBy("DAY_DESC")}>
        前日比 {sortIndicator("DAY_DESC")}
      </button>
      <button type="button" className={`mobile-sort-btn right ${sortBy === "VALUE_DESC" || sortBy === "GAIN_DESC" ? "active" : ""}`} onClick={() => setSortBy(sortBy === "VALUE_DESC" ? "GAIN_DESC" : "VALUE_DESC")}>
        {sortBy === "GAIN_DESC" ? "含み損益" : "評価額"} <span className="sort-arrow active" aria-hidden="true">↓</span>
      </button>
    </div>
    <table>
      <thead>
        <tr>
          <th className={`sortable ${sortBy === "NAME_ASC" ? "active-sort" : ""}`} onClick={() => setSortBy("NAME_ASC")}>銘柄 {sortIndicator("NAME_ASC")}</th>
          <th style={{ textAlign: "center" }}>推移</th>
          <th className={`sortable ${sortBy === "PRICE_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("PRICE_DESC")}>現在値 {sortIndicator("PRICE_DESC")}</th>
          <th className={`sortable ${sortBy === "DAY_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("DAY_DESC")}>前日比 {sortIndicator("DAY_DESC")}</th>
          <th>保有数 / 平均</th>
          <th className={`sortable ${sortBy === "VALUE_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("VALUE_DESC")}>評価額 {sortIndicator("VALUE_DESC")}</th>
          <th className={`sortable ${sortBy === "GAIN_DESC" ? "active-sort" : ""}`} onClick={() => setSortBy("GAIN_DESC")}>含み損益率 {sortIndicator("GAIN_DESC")}</th>
          <th>比率</th>
        </tr>
      </thead>
      <tbody>{sortedHoldings.map((holding: any) => {
    const rowCurrency = (currency === "NATIVE" ? (holding.security?.currency ?? holding.security?.nativeCurrency ?? "JPY") : currency) as DisplayCurrency;
    const quote = holding.security.quote as RemoteQuote | undefined;
    const price = holding.currentPrice == null ? null : Number(holding.currentPrice);
    const previous = quote?.previousRegularClose == null ? null : Number(quote.previousRegularClose);
    const day = holding.dayGain == null ? null : Number(holding.dayGain);
    const dayPercent = price != null && previous ? price / previous - 1 : null;
    const gain = holding.unrealizedGain == null ? null : Number(holding.unrealizedGain);
    const gainPercent = gain != null && Number(holding.totalCost) ? gain / Number(holding.totalCost) : null;
    const intraday = (intradayBySecurity?.get(holding.securityId) ?? []) as IntradayBar[];
    const showDailyFundTrend = isFundSecurity(holding.security) || shouldShowDailyFundTrend(holding.security, marketFilter);
    const dailyHistory = (dailyHistoryBySecurity?.get(holding.securityId) ?? []) as MarketBar[];
    const hasIntraday = intraday.length >= 2;
    const weightVal = holding.summaryMarketValue ?? holding.marketValue;
    return <tr key={holding.securityId} className={onSelect ? "selectable" : ""} onClick={() => onSelect?.(holding.securityId)} onKeyDown={(event) => { if (onSelect && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(holding.securityId); } }} tabIndex={onSelect ? 0 : undefined} aria-label={onSelect ? `${holding.security.name}の詳細を開く` : undefined}>
      <td className="security-col"><strong title={holding.security.legalName}>{holding.security.name}</strong><span className="security-symbol">{holding.security.displaySymbol} · {marketDisplayName(holding.security)}{quote ? ` · ${marketTimeLabel(quote.marketTimestamp, holding.security.exchangeMic, holding.security.timezone, holding.security.currency)}` : ""}</span></td>
      <td className="sparkline-col">{showDailyFundTrend || (!hasIntraday && (dailyHistory.length >= 2 || intraday.length >= 2))
        ? <DailyFundSparkline bars={dailyHistory.length >= 2 ? dailyHistory : intraday.map((bar) => ({ securityId: bar.securityId, date: bar.timestamp.slice(0, 10), close: bar.price, provider: bar.provider }))} currency={rowCurrency}/>
        : <IntradaySparkline bars={intraday} previousClose={previous} positive={Number(day ?? 0) >= 0} currency={rowCurrency} exchangeMic={holding.security.exchangeMic} timeZone={holding.security.timezone} stockCurrency={holding.security.currency}/>}</td>
      <td className="price-col"><strong>{maybeMoney(holding.currentPrice, rowCurrency)}</strong></td>
      <td className={`day-col ${day == null ? "" : day >= 0 ? "up" : "down"}`}><strong>{dayPercent == null ? "—" : signedPercent(dayPercent)}</strong><span aria-label={amountsVisible ? undefined : "金額非表示"}>{amountsVisible ? maybeSignedMoney(day, rowCurrency) : HIDDEN_AMOUNT}</span></td>
      <td className="position-col"><strong aria-label={amountsVisible ? undefined : "保有数非表示"}>{amountsVisible ? `${number.format(Number(holding.quantity))}${securityQuantityUnit(holding.security)}` : HIDDEN_AMOUNT}</strong><span aria-label={amountsVisible ? undefined : "平均取得単価非表示"}>{amountsVisible ? `@ ${money(Number(holding.averageCost), rowCurrency)}${isFundSecurity(holding.security) ? ` / ${securityPriceBasis(holding.security)}` : ""}` : HIDDEN_AMOUNT}</span></td>
      <td className="value-col"><strong aria-label={amountsVisible ? undefined : "金額非表示"}><span className="wide-number">{amountsVisible ? maybeMoney(holding.marketValue, rowCurrency) : HIDDEN_AMOUNT}</span><span className="compact-number">{amountsVisible ? holding.marketValue == null ? "—" : compactMoney(Number(holding.marketValue), rowCurrency) : HIDDEN_AMOUNT}</span></strong></td>
      <td className="gain-col"><strong className={gain == null ? "" : gain >= 0 ? "up" : "down"}>{signedPercent(gainPercent, 1)}</strong></td>
      <td className="weight-col"><strong>{totalValue != null && weightVal != null ? `${((Number(weightVal) / totalValue) * 100).toFixed(1)}%` : "—"}</strong><span className={`quote-dot ${quote?.freshness ?? "missing"}`} title={quote ? `${quote.freshness === "near_live" ? "" : `${freshnessLabel[quote.freshness]} · `}${marketDateTimeLabel(quote.marketTimestamp, holding.security.exchangeMic, holding.security.timezone, holding.security.currency)}（市場現地）` : "価格未取得"}/></td>
    </tr>;
  })}</tbody></table></div>;
}

function DailyFundSparkline({ bars, currency }: { bars: MarketBar[]; currency: DisplayCurrency }) {
  const orderedBars = [...bars]
    .filter((bar) => Number.isFinite(Number(bar.close)))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latestDate = orderedBars.at(-1)?.date.slice(0, 10);
  const cutoff = latestDate ? new Date(`${latestDate}T00:00:00Z`) : null;
  cutoff?.setUTCMonth(cutoff.getUTCMonth() - 1);
  const recentBars = cutoff
    ? orderedBars.filter((bar) => new Date(`${bar.date.slice(0, 10)}T00:00:00Z`) >= cutoff)
    : [];
  const selectedBars = recentBars.length >= 2 ? recentBars : orderedBars.slice(-30);
  const shortDate = (date: string) => {
    const [, month, day] = date.slice(0, 10).split("-");
    return month && day ? `${Number(month)}/${Number(day)}` : "—";
  };
  if (selectedBars.length < 2) return <span className="ticker-sparkline-wrap fund-daily-empty"><svg className="ticker-sparkline empty" viewBox="0 0 120 44" role="img" aria-label="日次基準価額の履歴なし"><path d="M2 22H118"/></svg><span className="sparkline-times" aria-hidden="true"><span>日次更新</span></span></span>;
  const values = selectedBars.map((bar) => Number(bar.close));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.05, rawMax * 0.0005);
  const min = rawMin - padding;
  const spread = rawMax + padding - min || 1;
  const y = (value: number) => 40 - ((value - min) / spread) * 36;
  const points = values.map((value, index) => `${2 + (index / (values.length - 1)) * 116},${y(value)}`).join(" ");
  const positive = values.at(-1)! >= values[0];
  return <span className="ticker-sparkline-wrap fund-daily-sparkline">
    <svg className={`ticker-sparkline ${positive ? "positive" : "negative"}`} viewBox="0 0 120 44" preserveAspectRatio="none" role="img" aria-label={`基準価額1か月推移、${shortDate(selectedBars[0].date)}から${shortDate(selectedBars.at(-1)!.date)}、最新 ${money(values.at(-1)!, currency)}`}>
      <g className="spark-grid"><line x1="2" y1="3" x2="118" y2="3"/><line x1="2" y1="22" x2="118" y2="22"/><line x1="2" y1="41" x2="118" y2="41"/></g>
      <polyline points={points}/>
    </svg>
    <span className="sparkline-times" aria-hidden="true"><time>{shortDate(selectedBars[0].date)}</time><span>1M・日次</span><time>{shortDate(selectedBars.at(-1)!.date)}</time></span>
  </span>;
}

function IntradaySparkline({ bars, previousClose, positive, currency, exchangeMic, timeZone, stockCurrency }: { bars: IntradayBar[]; previousClose: number | null; positive: boolean; currency: DisplayCurrency; exchangeMic: string; timeZone?: string; stockCurrency?: string }) {
  const orderedBars = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const latestDate = orderedBars.map((bar) => marketDateKey(bar.timestamp, exchangeMic, timeZone, stockCurrency)).filter(Boolean).at(-1);
  const currentSessionBars = latestDate ? orderedBars.filter((bar) => marketDateKey(bar.timestamp, exchangeMic, timeZone, stockCurrency) === latestDate) : [];
  const selectedBars = currentSessionBars.length >= 2 ? currentSessionBars : orderedBars.slice(-30);
  if (selectedBars.length < 2) return <span className="ticker-sparkline-wrap"><svg className="ticker-sparkline empty" viewBox="0 0 120 44" role="img" aria-label="日中価格データなし"><path d="M2 22H118"/></svg></span>;
  const values = selectedBars.map((bar) => Number(bar.price));
  const scaleValues = previousClose == null ? values : [...values, previousClose];
  const rawMin = Math.min(...scaleValues);
  const rawMax = Math.max(...scaleValues);
  const padding = Math.max((rawMax - rawMin) * 0.05, rawMax * 0.0005);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const spread = max - min || 1;
  const y = (value: number) => 40 - ((value - min) / spread) * 36;
  const points = values.map((value, index) => `${2 + (index / (values.length - 1)) * 116},${y(value)}`).join(" ");
  const previousY = previousClose == null ? null : y(previousClose);
  const timeTicks = sparseIntradayTimeTicks(selectedBars);
  const timeLabel = (timestamp: string) => marketTimeLabel(timestamp, exchangeMic, timeZone, stockCurrency);
  return <span className="ticker-sparkline-wrap">
    <svg className={`ticker-sparkline ${positive ? "positive" : "negative"}`} viewBox="0 0 120 44" preserveAspectRatio="none" role="img" aria-label={`日中価格 ${money(values.at(-1) ?? 0, currency)}、市場現地時間${timeLabel(timeTicks[0])}から${timeLabel(timeTicks.at(-1)!)}、前日終値 ${previousClose == null ? "不明" : money(previousClose, currency)}`}>
      <g className="spark-grid"><line x1="2" y1="3" x2="118" y2="3"/><line x1="2" y1="22" x2="118" y2="22"/><line x1="2" y1="41" x2="118" y2="41"/></g>
      {previousY != null && <line className="previous-close" x1="2" y1={previousY} x2="118" y2={previousY}/>}
      <polyline points={points}/>
    </svg>
    <span className="sparkline-times" aria-hidden="true">{timeTicks.map((timestamp) => <time key={timestamp}>{timeLabel(timestamp)}</time>)}</span>
  </span>;
}

function SecurityDetailView({ holding, transactions, accountMap, historyBars, corporateActions, historyStatus, onBack, returnView = "overview", currency, notifications, readNotificationIds, onReadNotification, onEditTransaction, onDeleteTransaction, amountsVisible }: any) {
  const returnViewLabel = returnView === "watchlist" ? "検索" : returnView === "activity" ? "取引履歴" : returnView === "notifications" ? "通知" : returnView === "performance" ? "推移" : "一覧";
  const [detailTab, setDetailTab] = useState<"chart" | "activity" | "notifications">("chart");
  const [detailRange, setDetailRange] = useState<RangeKey>("ALL");
  const [detailCustomRange, setDetailCustomRange] = useState<CustomDateRange | null>(null);
  const [detailChartMode, setDetailChartMode] = useState<SecurityChartMode>(transactions.length > 0 ? "position" : "price");
  const activeCurrency = (currency === "NATIVE" ? (holding.security?.currency ?? holding.security?.nativeCurrency ?? "JPY") : currency) as DisplayCurrency;
  const quote = holding.security.quote as RemoteQuote | undefined;
  const fund = isFundSecurity(holding.security);
  const index = isIndexSecurity(holding.security);
  const currentMarketDate = marketDateKey(quote?.marketTimestamp ?? new Date().toISOString(), holding.security.exchangeMic, holding.security.timezone, holding.security.currency) || localDateInputValue();
  const previous = quote?.previousRegularClose == null ? null : Number(quote.previousRegularClose);
  const day = holding.dayGain == null ? null : Number(holding.dayGain);
  const dayReturn = previous && holding.currentPrice != null ? Number(holding.currentPrice) / previous - 1 : null;
  const gain = holding.unrealizedGain == null && holding.realizedGain == null ? null : Number(holding.unrealizedGain ?? 0) + Number(holding.realizedGain ?? 0);
  const gainPercent = gain != null && Number(holding.totalCost) ? gain / Number(holding.totalCost) : null;
  const hasPosition = transactions.length > 0 && Number(holding.quantity) > 0;
  const detailSecurityMap = new Map([[holding.securityId, holding.security]]);

  const allPerformance = useMemo(() => {
    const points = reconstructSecurityHistory(holding.securityId, historyBars, transactions, corporateActions, holding.security.priceUnit);
    if (holding.marketValue != null && Number(holding.marketValue) > 0) {
      const current = { date: currentMarketDate, price: Number(holding.currentPrice), value: Number(holding.marketValue), capital: Number(holding.totalCost), quantity: Number(holding.quantity) };
      if (points.at(-1)?.date === current.date) points[points.length - 1] = current;
      else points.push(current);
    }
    return points;
  }, [corporateActions, currentMarketDate, historyBars, holding.currentPrice, holding.marketValue, holding.quantity, holding.security.priceUnit, holding.securityId, holding.totalCost, transactions]);

  const allPrices = useMemo(() => {
    const points = (historyBars as MarketBar[])
      .filter((bar) => bar.securityId === holding.securityId)
      .sort((a: MarketBar, b: MarketBar) => a.date.localeCompare(b.date))
      .map((bar: MarketBar) => ({ date: bar.date, price: Number(bar.adjustedClose ?? bar.close) }));
    if (points.length > 0 && holding.currentPrice != null) {
      const current = { date: currentMarketDate, price: Number(holding.currentPrice) };
      if (points.at(-1)?.date === current.date) points[points.length - 1] = current;
      else points.push(current);
    }
    return points;
  }, [currentMarketDate, historyBars, holding.currentPrice, holding.securityId]);

  const activeHistory = hasPosition && detailChartMode === "position" ? allPerformance : allPrices;
  const performanceHistory = useMemo(() => filterDatedHistory(allPerformance, detailRange, detailCustomRange), [allPerformance, detailCustomRange, detailRange]);
  const priceHistory = useMemo(() => filterDatedHistory(allPrices, detailRange, detailCustomRange), [allPrices, detailCustomRange, detailRange]);

  const detailDateBounds = {
    min: activeHistory[0]?.date.slice(0, 10) ?? transactions.map((transaction: any) => transaction.tradeDate.slice(0, 10)).sort()[0] ?? currentMarketDate,
    max: activeHistory.at(-1)?.date.slice(0, 10) ?? currentMarketDate,
  };

  const adjustedTransactions = useMemo(() => deriveSplitAdjustedTransactions(transactions, corporateActions), [corporateActions, transactions]);

  const tradeSummary = useMemo(() => (["BUY", "SELL"] as const).map((type) => {
    const rows = adjustedTransactions.filter((transaction: any) => transaction.type === type);
    const quantity = rows.reduce((sum: number, transaction: any) => sum + Math.abs(Number(transaction.quantity ?? 0)), 0);
    const pricedQuantity = rows.reduce((sum: number, transaction: any) => Number.isFinite(Number(transaction.pricePerShare)) ? sum + Math.abs(Number(transaction.quantity ?? 0)) : sum, 0);
    const weightedPrice = rows.reduce((sum: number, transaction: any) => sum + Math.abs(Number(transaction.quantity ?? 0)) * Math.abs(Number(transaction.pricePerShare ?? 0)), 0);
    const gross = rows.reduce((sum: number, transaction: any) => sum + Math.abs(Number(transaction.grossAmount ?? 0)), 0);
    return { type, count: rows.length, quantity, averagePrice: pricedQuantity ? weightedPrice / pricedQuantity : null, gross };
  }), [adjustedTransactions]);

  const unreadNotificationCount = notifications.filter((n: any) => !readNotificationIds?.includes(n.id)).length;

  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const handlePageTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, textarea, [role='slider'], .segmented, svg")) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      t: performance.now(),
    };
  };

  const handlePageTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const elapsed = Math.max(1, performance.now() - touchStartRef.current.t);
    const velocityX = deltaX / elapsed;

    if (deltaX > 45 && Math.abs(deltaY) < Math.abs(deltaX) * 0.7 && (deltaX >= 60 || velocityX >= 0.3)) {
      onBack();
    }
    touchStartRef.current = null;
  };

  return (
    <div
      className="security-detail-page"
      onTouchStart={handlePageTouchStart}
      onTouchEnd={handlePageTouchEnd}
      onTouchCancel={() => { touchStartRef.current = null; }}
    >
      {/* 1. Header consistent with view-header */}
      <section className="view-header detail-header" aria-label="銘柄詳細ヘッダー">
        <div className="view-header-title-group detail-header-group">
          <button
            type="button"
            className="detail-back-button"
            onClick={onBack}
            aria-label={`${returnViewLabel}に戻る`}
            title={`${returnViewLabel}に戻る`}
          >
            <ArrowLeft size={16} />
            <span>{returnViewLabel}</span>
          </button>
          <div className="detail-title-block">
            <div className="detail-title-line">
              <h1 title={holding.security.legalName}>{holding.security.name}</h1>
              <span className="detail-symbol-pill">{holding.security.displaySymbol}</span>
              <span className="detail-market-text">{marketDisplayName(holding.security)} · {holding.security.nativeCurrency ?? holding.security.currency}</span>
            </div>
            <div className="detail-meta-line">
              {quote ? (
                <span className="detail-live-tag">
                  <i className="detail-live-dot" />
                  {quoteTradeSourceLabel(quote)} {marketDateTimeLabel(quote.marketTimestamp, holding.security.exchangeMic, holding.security.timezone, holding.security.currency)}
                  <span className="detail-dot-sep">·</span>
                  {freshnessLabel[quote.freshness]}
                </span>
              ) : (
                <span className="detail-meta-text">価格未取得</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 2. Unified Summary (Matching 一覧's .daily-summary) */}
      <section className="daily-grid detail-summary-grid" aria-label="銘柄指標サマリー">
        <div className="daily-summary detail-summary">
          <div className="daily-summary-main">
            <div className="daily-stat-item primary">
              <span className="daily-stat-label">
                {fund ? `基準価額 (${activeCurrency})` : index ? `指数値 (${activeCurrency})` : `現在値 (${activeCurrency})`}
              </span>
              <strong className="daily-stat-val">
                {maybeMoney(holding.currentPrice, activeCurrency)}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">前日比</span>
              <div className="daily-stat-inline">
                <strong className={`daily-stat-val ${Number(day ?? 0) >= 0 ? "up" : "down"}`}>
                  {dayReturn != null ? signedPercent(dayReturn) : "—"}
                </strong>
                {hasPosition && (
                  <small className={`daily-stat-sub ${Number(day ?? 0) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                    ({amountsVisible ? maybeSignedMoney(day, activeCurrency) : HIDDEN_AMOUNT})
                  </small>
                )}
              </div>
            </div>
          </div>

          <div className="daily-summary-divider" aria-hidden="true" />

          <div className="daily-summary-metrics detail-summary-metrics">
            <div className="daily-stat-item">
              <span className="daily-stat-label">{fund ? "保有口数" : "保有数"}</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "保有数非表示"}>
                {hasPosition ? (amountsVisible ? `${number.format(Number(holding.quantity))}${securityQuantityUnit(holding.security)}` : HIDDEN_AMOUNT) : "0株"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">平均取得</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "平均取得非表示"}>
                {hasPosition && Number(holding.averageCost) > 0 ? (amountsVisible ? `${maybeMoney(holding.averageCost, activeCurrency)}${fund ? ` / ${securityPriceBasis(holding.security)}` : ""}` : HIDDEN_AMOUNT) : "—"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">評価額</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "評価額非表示"}>
                {hasPosition && Number(holding.marketValue) > 0 ? (amountsVisible ? maybeMoney(holding.marketValue, activeCurrency) : HIDDEN_AMOUNT) : "—"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">取得原価</span>
              <strong className="daily-stat-val" aria-label={amountsVisible ? undefined : "取得原価非表示"}>
                {hasPosition && Number(holding.totalCost) > 0 ? (amountsVisible ? maybeMoney(holding.totalCost, activeCurrency) : HIDDEN_AMOUNT) : "—"}
              </strong>
            </div>
            <div className="daily-stat-item">
              <span className="daily-stat-label">累計損益</span>
              {hasPosition ? (
                <div className="daily-stat-inline">
                  <strong className={`daily-stat-val ${Number(gain ?? 0) >= 0 ? "up" : "down"}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                    {amountsVisible ? compactMoney(Number(gain), activeCurrency, true) : HIDDEN_AMOUNT}
                  </strong>
                  <small className={`daily-stat-sub ${Number(gain ?? 0) >= 0 ? "up" : "down"}`}>
                    ({signedPercent(gainPercent, 1)})
                  </small>
                </div>
              ) : (
                <strong className="daily-stat-val" style={{ color: "var(--muted)" }}>未保有</strong>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 3. Detail View Tabs (Chart / Activity / Notifications) - Clean Text, Larger Touch Target */}
      <div className="detail-tab-nav" role="tablist" aria-label="銘柄詳細メニュー切り替え">
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === "chart"}
          className={`detail-tab-btn ${detailTab === "chart" ? "active" : ""}`}
          onClick={() => setDetailTab("chart")}
        >
          チャート
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === "activity"}
          className={`detail-tab-btn ${detailTab === "activity" ? "active" : ""}`}
          onClick={() => setDetailTab("activity")}
        >
          取引履歴
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={detailTab === "notifications"}
          className={`detail-tab-btn ${detailTab === "notifications" ? "active" : ""}`}
          onClick={() => setDetailTab("notifications")}
        >
          <span>通知・イベント</span>
          {unreadNotificationCount > 0 && <span className="detail-tab-unread-dot" aria-label="未読あり" />}
        </button>
      </div>

      {/* 4. Tab Content Panes (Zero Nested Scrolling) */}
      {detailTab === "chart" && (
        <section className="detail-tab-content detail-chart-section" aria-label="チャート・値動き">
          <div className="detail-chart-toolbar">
            <div className="detail-chart-mode segmented" role="tablist" aria-label="チャート種類">
              {hasPosition && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailChartMode === "position"}
                  className={detailChartMode === "position" ? "active" : ""}
                  onClick={() => setDetailChartMode("position")}
                >
                  保有状況
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={detailChartMode === "price" || !hasPosition}
                className={detailChartMode === "price" || !hasPosition ? "active" : ""}
                onClick={() => setDetailChartMode("price")}
              >
                {fund ? "基準価額" : index ? "指数値" : "株価"}
              </button>
            </div>

            <div className="detail-range chart-range-menu">
              <div className="chart-range-presets segmented" aria-label="チャート期間">
                {(["1W", "1M", "3M", "YTD", "ALL"] as RangeKey[]).map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={detailRange === item ? "active" : ""}
                    onClick={() => setDetailRange(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <DateRangeControl
                value={detailCustomRange}
                active={detailRange === "CUSTOM"}
                min={detailDateBounds.min}
                max={detailDateBounds.max}
                onApply={(next) => {
                  setDetailCustomRange(next);
                  setDetailRange("CUSTOM");
                }}
              />
            </div>
          </div>

          <div className="detail-chart-body">
            {hasPosition && detailChartMode === "position" ? (
              <PortfolioChart
                history={performanceHistory}
                historyStatus={historyStatus}
                zeroBased={detailRange === "ALL"}
                showCapital={detailRange !== "1W"}
                compact
                currency={activeCurrency}
                amountsVisible={amountsVisible}
                detailsEnabled
              />
            ) : (
              <StockPriceChart
                history={priceHistory}
                historyStatus={historyStatus}
                currency={activeCurrency}
                zeroBased={detailRange === "ALL"}
                compact
                label={fund ? "基準価額" : index ? "指数値" : "株価"}
                detailsEnabled
              />
            )}
          </div>
        </section>
      )}

      {detailTab === "activity" && (
        <section className="detail-tab-content detail-activity-section" aria-label="取引履歴">
          <div className="detail-trade-summary-card">
            <div className="detail-trade-summary-head">
              <strong>売買集計</strong>
              <small>{currency === "NATIVE" ? `${activeCurrency}（現地通貨）` : `${currency} 換算`}</small>
            </div>
            <div className="detail-trade-summary-grid">
              {tradeSummary.map((item) => (
                <div key={item.type} className={`detail-trade-item ${item.type.toLowerCase()}`}>
                  <div className="detail-trade-item-side">
                    <span className={`trade-badge ${item.type === "BUY" ? "buy" : "sell"}`}>
                      {item.type === "BUY" ? "買付" : "売却"}
                    </span>
                    <strong>{item.count}件</strong>
                  </div>
                  <div className="detail-trade-item-metrics">
                    <div className="detail-trade-metric">
                      <span>数量:</span>
                      <strong aria-label={amountsVisible ? undefined : "数量非表示"}>
                        {amountsVisible ? `${number.format(item.quantity)}${securityQuantityUnit(holding.security)}` : HIDDEN_AMOUNT}
                      </strong>
                    </div>
                    <div className="detail-trade-metric">
                      <span>平均:</span>
                      <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
                        {amountsVisible ? (item.averagePrice == null ? "—" : `${money(item.averagePrice, activeCurrency)}${fund ? ` / ${securityPriceBasis(holding.security)}` : ""}`) : HIDDEN_AMOUNT}
                      </strong>
                    </div>
                    <div className="detail-trade-metric">
                      <span>総額:</span>
                      <strong aria-label={amountsVisible ? undefined : "金額非表示"}>
                        {amountsVisible ? compactMoney(item.gross, activeCurrency) : HIDDEN_AMOUNT}
                      </strong>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="detail-ledger-wrap">
            <Ledger
              rows={transactions}
              securityMap={detailSecurityMap}
              accountMap={accountMap}
              corporateActions={corporateActions}
              onEdit={onEditTransaction}
              onDelete={onDeleteTransaction}
              amountsVisible={amountsVisible}
            />
          </div>
        </section>
      )}

      {detailTab === "notifications" && (
        <section className="detail-tab-content detail-notifications-section" aria-label="通知・イベント">
          <div className="detail-notifications-head">
            <strong>銘柄関連の通知・イベント</strong>
            <small>{notifications.length}件</small>
          </div>
          {notifications.length > 0 ? (
            <div className="detail-notifications-list">
              <NotificationRows
                notifications={notifications}
                securityMap={detailSecurityMap}
                readIds={new Set(readNotificationIds)}
                onRead={onReadNotification}
                compact={false}
              />
            </div>
          ) : (
            <div className="detail-notifications-empty">
              <p>この銘柄に関する通知やコーポレートアクションはありません</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Ledger({ rows, securityMap, accountMap, corporateActions = [], onEdit, onDelete, onOpenTrade, amountsVisible = true }: any) {
  const adjustedRows = useMemo(() => deriveSplitAdjustedTransactions(rows, corporateActions), [corporateActions, rows]);
  const ordered = useMemo(() => [...adjustedRows].sort((a: any, b: any) => b.tradeDate.localeCompare(a.tradeDate) || b.id.localeCompare(a.id)), [adjustedRows]);
  const positionSnapshots = useMemo(() => deriveTransactionPositionSnapshots(rows, corporateActions), [corporateActions, rows]);

  if (!ordered.length) {
    return (
      <div className="ledger-empty panel">
        <p>取引履歴はありません</p>
        {onOpenTrade && (
          <button type="button" className="trade-button" onClick={onOpenTrade}>
            <Plus size={14} />
            <span>取引を記録</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="holdings-table-wrap ledger-table-wrap panel">
      {/* Mobile Card List (Structured & Spacious, No Overflow) */}
      <div className="ledger-mobile-cards mobile-only">
        {ordered.map((transaction: any) => {
          const security = transaction.securityId ? securityMap.get(transaction.securityId) : null;
          const unit = securityQuantityUnit(security);
          const account = accountMap.get(transaction.accountId);
          const isBuy = transaction.type === "BUY";
          const isSell = transaction.type === "SELL";
          const typeLabel = isBuy ? "買付" : isSell ? "売却" : transaction.type === "TRANSFER_IN" ? "入庫" : transaction.type === "WITHDRAWAL" ? "出金" : "入金";
          const typeTone = isBuy ? "buy" : isSell ? "sell" : "neutral";
          const transactionCurrency = transaction.tradeCurrency ?? "JPY";
          const editable = Boolean(onEdit && security && (isBuy || isSell));
          const position = positionSnapshots.get(transaction.id);

          return (
            <article key={transaction.id} className="ledger-card">
              <div className="ledger-card-primary">
                <div className="ledger-card-title-group">
                  <span className={`ledger-side-badge ${typeTone}`}>{typeLabel}</span>
                  <strong className="ledger-card-name">{security ? security.name : "現金"}</strong>
                  {security?.displaySymbol && (
                    <span className="ledger-symbol-pill">{security.displaySymbol}</span>
                  )}
                </div>
                <strong className={`ledger-card-gross ${typeTone}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                  {amountsVisible ? maybeMoney(transaction.grossAmount, transactionCurrency) : HIDDEN_AMOUNT}
                </strong>
              </div>

              <div className="ledger-card-secondary">
                <div className="ledger-card-meta">
                  <time>{dateJa(transaction.tradeDate)}</time>
                  {account?.name && (
                    <>
                      <span className="ledger-dot">·</span>
                      <span className="ledger-card-account">{account.name}</span>
                    </>
                  )}
                </div>
                <div className="ledger-card-unit-info">
                  {amountsVisible ? (
                    <>
                      <span className="ledger-card-qty">{transaction.quantity ? `${number.format(Math.abs(Number(transaction.quantity)))}${unit}` : "—"}</span>
                      {transaction.pricePerShare != null && (
                        <span className="ledger-card-at">
                          @ {maybeMoney(transaction.pricePerShare, transactionCurrency)}
                          {isFundSecurity(security) ? ` / ${securityPriceBasis(security)}` : ""}
                        </span>
                      )}
                    </>
                  ) : (
                    <span>{HIDDEN_AMOUNT}</span>
                  )}
                </div>
              </div>

              {(position?.afterQuantity != null || editable || onDelete) && (
                <div className="ledger-card-footer">
                  <div className="ledger-card-pos">
                    {amountsVisible && position?.beforeQuantity != null && position?.afterQuantity != null && (
                      <span className="ledger-card-pos-text">
                        保有推移: {number.format(Number(position.beforeQuantity))} → <strong>{number.format(Number(position.afterQuantity))}{unit}</strong>
                      </span>
                    )}
                  </div>
                  <div className="ledger-card-actions">
                    {editable && (
                      <button
                        type="button"
                        className="ledger-action-btn edit"
                        aria-label={`${security?.name ?? "銘柄"} ${dateJa(transaction.tradeDate)}を編集`}
                        title="取引を編集"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(transaction.id);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        className="ledger-action-btn delete"
                        aria-label={`${security?.name ?? "取引"} ${dateJa(transaction.tradeDate)}を削除`}
                        title="取引を削除"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(transaction.id);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {/* Desktop Table View */}
      <table className="holdings-table ledger-table desktop-only">
        <thead>
          <tr>
            <th className="ledger-date-col">日付</th>
            <th className="ledger-type-col">種別</th>
            <th className="ledger-security-col">銘柄 / 口座</th>
            <th className="ledger-quantity-col">数量</th>
            <th className="ledger-position-col">保有数推移</th>
            <th className="ledger-unit-price-col">約定単価</th>
            <th className="ledger-gross-col">約定金額</th>
            <th className="ledger-action-col">操作</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((transaction: any) => {
            const security = transaction.securityId ? securityMap.get(transaction.securityId) : null;
            const unit = securityQuantityUnit(security);
            const account = accountMap.get(transaction.accountId);
            const isBuy = transaction.type === "BUY";
            const isSell = transaction.type === "SELL";
            const typeLabel = isBuy ? "買付" : isSell ? "売却" : transaction.type === "TRANSFER_IN" ? "入庫" : transaction.type === "WITHDRAWAL" ? "出金" : "入金";
            const typeTone = isBuy ? "buy" : isSell ? "sell" : "neutral";
            const transactionCurrency = transaction.tradeCurrency ?? "JPY";
            const editable = Boolean(onEdit && security && (isBuy || isSell));
            const position = positionSnapshots.get(transaction.id);

            return (
              <tr key={transaction.id} className="ledger-row">
                <td className="ledger-date-col">
                  <time>{dateJa(transaction.tradeDate)}</time>
                </td>
                <td className="ledger-type-col">
                  <span className={`ledger-side-badge ${typeTone}`}>{typeLabel}</span>
                </td>
                <td className="ledger-security-col">
                  <div className="ledger-security-info">
                    <div className="ledger-security-title">
                      <strong className="ledger-security-name">{security ? security.name : "現金"}</strong>
                      {security?.displaySymbol && (
                        <span className="ledger-symbol-pill">{security.displaySymbol}</span>
                      )}
                    </div>
                    <div className="ledger-security-meta">
                      <span className="ledger-account">{account?.name ?? "口座未設定"}</span>
                    </div>
                  </div>
                </td>
                <td className="ledger-quantity-col">
                  <span className="ledger-num" aria-label={amountsVisible ? undefined : "数量非表示"}>
                    {amountsVisible ? transaction.quantity ? `${number.format(Math.abs(Number(transaction.quantity)))}${unit}` : "—" : HIDDEN_AMOUNT}
                  </span>
                </td>
                <td className="ledger-position-col">
                  <span className="ledger-position-shift" aria-label={amountsVisible ? undefined : "保有数非表示"}>
                    {amountsVisible ? (
                      position?.beforeQuantity == null || position.afterQuantity == null ? (
                        "—"
                      ) : (
                        <>
                          <span className="ledger-pos-before">{number.format(Number(position.beforeQuantity))}</span>
                          <i className="ledger-arrow">→</i>
                          <strong className="ledger-pos-after">{number.format(Number(position.afterQuantity))}{unit}</strong>
                        </>
                      )
                    ) : (
                      HIDDEN_AMOUNT
                    )}
                  </span>
                </td>
                <td className="ledger-unit-price-col">
                  <span className="ledger-num" aria-label={amountsVisible ? undefined : "金額非表示"}>
                    {amountsVisible ? transaction.pricePerShare != null ? <>{maybeMoney(transaction.pricePerShare, transactionCurrency)}{isFundSecurity(security) ? ` / ${securityPriceBasis(security)}` : ""}</> : "—" : HIDDEN_AMOUNT}
                  </span>
                </td>
                <td className="ledger-gross-col">
                  <strong className={`ledger-gross-amount ${typeTone}`} aria-label={amountsVisible ? undefined : "金額非表示"}>
                    {amountsVisible ? maybeMoney(transaction.grossAmount, transactionCurrency) : HIDDEN_AMOUNT}
                  </strong>
                </td>
                <td className="ledger-action-col">
                  <div className="ledger-actions">
                    {editable && (
                      <button
                        type="button"
                        className="ledger-action-btn edit"
                        aria-label={`${security?.name ?? "銘柄"} ${dateJa(transaction.tradeDate)}を編集`}
                        title="取引を編集"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(transaction.id);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                    {onDelete && (
                      <button
                        type="button"
                        className="ledger-action-btn delete"
                        aria-label={`${security?.name ?? "取引"} ${dateJa(transaction.tradeDate)}を削除`}
                        title="取引を削除"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(transaction.id);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CalendarActivity({ transactions }: any) {
  const initial = [...transactions].map((row: any) => row.tradeDate.slice(0, 7)).sort().at(-1) ?? new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(initial);
  const [year, monthNumber] = month.split("-").map(Number);
  const firstDay = new Date(year, monthNumber - 1, 1).getDay();
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const byDay = new Map<number, any[]>();
  for (const row of transactions) {
    if (!row.tradeDate.startsWith(month)) continue;
    const day = Number(row.tradeDate.slice(8, 10));
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const moveMonth = (delta: number) => {
    const next = new Date(year, monthNumber - 1 + delta, 1);
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
  };
  return <section className="activity-calendar panel"><div className="calendar-toolbar"><button onClick={() => moveMonth(-1)} aria-label="前の月">‹</button><strong>{year}年{monthNumber}月</strong><button onClick={() => moveMonth(1)} aria-label="次の月">›</button></div><div className="calendar-weekdays">{["日", "月", "火", "水", "木", "金", "土"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: firstDay }, (_, index) => <div className="blank" key={`blank-${index}`}/>)}{Array.from({ length: daysInMonth }, (_, index) => { const day = index + 1; const rows = byDay.get(day) ?? []; const volume = rows.reduce((sum, row) => sum + Math.abs(Number(row.grossAmount ?? 0)), 0); const currencies = [...new Set(rows.map((row) => row.tradeCurrency ?? "JPY"))]; return <div className={rows.length ? "active" : ""} key={day}><span>{day}</span>{rows.length > 0 && <><strong>{rows.length}件</strong><small>{currencies.length === 1 ? compactMoney(volume, currencies[0] as DisplayCurrency) : "複数通貨"}</small></>}</div>; })}</div></section>;
}

function ActivityHistogram({ transactions }: any) {
  const grouped = new Map<string, { count: number; volume: number; currencies: Set<string> }>();
  for (const row of transactions) {
    const month = row.tradeDate.slice(0, 7);
    const current = grouped.get(month) ?? { count: 0, volume: 0, currencies: new Set<string>() };
    current.count += 1;
    current.volume += Math.abs(Number(row.grossAmount ?? 0));
    current.currencies.add(row.tradeCurrency ?? "JPY");
    grouped.set(month, current);
  }
  const rows = [...grouped].sort(([a], [b]) => a.localeCompare(b)).slice(-12);
  const maxCount = Math.max(1, ...rows.map(([, value]) => value.count));
  return <section className="activity-histogram panel">{rows.map(([month, value]) => <div key={month}><time>{month.replace("-", "/")}</time><div><i style={{ width: `${Math.max(5, value.count / maxCount * 100)}%` }}/></div><strong>{value.count}件</strong><span>{value.currencies.size === 1 ? compactMoney(value.volume, [...value.currencies][0] as DisplayCurrency) : "複数通貨"}</span></div>)}</section>;
}

function ActivityTradeSummary({ transactions }: any) {
  const stats = useMemo(() => {
    const tradeRows = transactions.filter((t: any) => t.type === "BUY" || t.type === "SELL");
    const buyRows = tradeRows.filter((t: any) => t.type === "BUY");
    const sellRows = tradeRows.filter((t: any) => t.type === "SELL");

    const buyGrossByCurrency: Record<string, number> = {};
    const sellGrossByCurrency: Record<string, number> = {};
    const netGrossByCurrency: Record<string, number> = {};

    for (const t of tradeRows) {
      const c = (t.tradeCurrency || t.currency || "JPY") as string;
      const gross = Math.abs(Number(t.grossAmount ?? (Number(t.quantity ?? 0) * Number(t.pricePerShare ?? 0))));
      if (t.type === "BUY") {
        buyGrossByCurrency[c] = (buyGrossByCurrency[c] ?? 0) + gross;
        netGrossByCurrency[c] = (netGrossByCurrency[c] ?? 0) + gross;
      } else if (t.type === "SELL") {
        sellGrossByCurrency[c] = (sellGrossByCurrency[c] ?? 0) + gross;
        netGrossByCurrency[c] = (netGrossByCurrency[c] ?? 0) - gross;
      }
    }

    return {
      totalCount: tradeRows.length,
      buyCount: buyRows.length,
      sellCount: sellRows.length,
      buyGrossByCurrency,
      sellGrossByCurrency,
      netGrossByCurrency,
    };
  }, [transactions]);

  if (!transactions.length) return null;

  const formatCurrencyMap = (map: Record<string, number>, fallbackZero = true) => {
    const entries = Object.entries(map).filter(([_, val]) => val !== 0 || fallbackZero);
    if (!entries.length) return fallbackZero ? "¥0" : "—";
    return entries.map(([curr, val]) => compactMoney(val, curr as DisplayCurrency, true)).join(" / ");
  };

  return (
    <div className="activity-summary-bar" aria-label="取引履歴サマリー">
      <div className="activity-stat-chip">
        <span className="activity-stat-label">取引</span>
        <strong className="activity-stat-val">{stats.totalCount}件</strong>
        <span className="activity-stat-sub">({stats.buyCount}買/{stats.sellCount}売)</span>
      </div>
      <div className="activity-stat-chip">
        <span className="activity-stat-label">総買付</span>
        <strong className="activity-stat-val buy">{formatCurrencyMap(stats.buyGrossByCurrency, true)}</strong>
      </div>
      <div className="activity-stat-chip">
        <span className="activity-stat-label">総売却</span>
        <strong className="activity-stat-val sell">{formatCurrencyMap(stats.sellGrossByCurrency, true)}</strong>
      </div>
      <div className="activity-stat-chip">
        <span className="activity-stat-label">純投資額</span>
        <strong className="activity-stat-val">{formatCurrencyMap(stats.netGrossByCurrency, true)}</strong>
      </div>
    </div>
  );
}

function ActivityView({ transactions, securityMap, accountMap, corporateActions, brokerOptions = [], onEdit, onDelete, onOpenTrade }: any) {
  const [mode, setMode] = useState<"list" | "calendar" | "frequency">("list");
  const [activityBrokerFilter, setActivityBrokerFilter] = useState<string>("ALL");
  const [activityMarketFilter, setActivityMarketFilter] = useState<string>("ALL");

  const filteredTransactions = useMemo(() => {
    return transactions.filter((t: any) => {
      const account = t.accountId ? accountMap.get(t.accountId) : null;
      const broker = account?.broker ?? t.original?.broker;
      if (activityBrokerFilter !== "ALL" && broker !== activityBrokerFilter) return false;
      if (activityMarketFilter !== "ALL") {
        const security = t.securityId ? securityMap.get(t.securityId) : null;
        if (!security) return false;
        if (activityMarketFilter === "JP" && security.country !== "JP") return false;
        if (activityMarketFilter === "US" && security.country !== "US") return false;
        if (activityMarketFilter === "FUNDS_INDEXES" && security.assetType !== "fund" && security.assetType !== "index" && security.assetType !== "etf") return false;
      }
      return true;
    });
  }, [transactions, activityBrokerFilter, activityMarketFilter, accountMap, securityMap]);

  return (
    <div className="activity-page">
      <ActivityTradeSummary transactions={filteredTransactions}/>
      {mode === "list" && <Ledger rows={filteredTransactions} securityMap={securityMap} accountMap={accountMap} corporateActions={corporateActions} onEdit={onEdit} onDelete={onDelete} onOpenTrade={onOpenTrade}/>}
      {mode === "calendar" && <CalendarActivity transactions={filteredTransactions}/>}
      {mode === "frequency" && <ActivityHistogram transactions={filteredTransactions}/>}

      {/* Bottom Controls: Single Row Dock with 3-Toggle Icon Buttons, Filters & Compact Plus Button */}
      <div className="activity-bottom-controls" data-swipe-ignore="true">
        <div className="segmented activity-modes" role="tablist" aria-label="取引履歴表示形式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "list"}
            aria-label="一覧"
            title="一覧"
            className={mode === "list" ? "active" : ""}
            onClick={() => setMode("list")}
          >
            <List size={16} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "calendar"}
            aria-label="カレンダー"
            title="カレンダー"
            className={mode === "calendar" ? "active" : ""}
            onClick={() => setMode("calendar")}
          >
            <CalendarDays size={16} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "frequency"}
            aria-label="頻度"
            title="頻度"
            className={mode === "frequency" ? "active" : ""}
            onClick={() => setMode("frequency")}
          >
            <BarChart3 size={16} />
          </button>
        </div>

        <div className="activity-filters" role="group" aria-label="取引履歴フィルター">
          <select
            aria-label="証券会社で絞り込み"
            className="activity-filter-select"
            value={activityBrokerFilter}
            onChange={(e) => setActivityBrokerFilter(e.target.value)}
          >
            <option value="ALL">全口座</option>
            {brokerOptions.map((broker: string) => (
              <option key={broker} value={broker}>{broker.replace("証券", "")}</option>
            ))}
          </select>
          <select
            aria-label="資産区分で絞り込み"
            className="activity-filter-select"
            value={activityMarketFilter}
            onChange={(e) => setActivityMarketFilter(e.target.value)}
          >
            <option value="ALL">全資産</option>
            <option value="JP">日本株</option>
            <option value="US">米国株</option>
            <option value="FUNDS_INDEXES">投信・指数</option>
          </select>
        </div>

        {onOpenTrade && (
          <button
            type="button"
            className="trade-button activity-add-btn"
            onClick={onOpenTrade}
            aria-label="取引を追加"
            title="取引を追加"
          >
            <Plus size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

const notificationTypeLabel: Record<PortfolioNotification["type"], string> = {
  SPLIT: "株式分割",
  REVERSE_SPLIT: "株式併合",
  LIMIT_UP: "ストップ高",
  LIMIT_DOWN: "ストップ安",
  PRICE_UP: "急騰",
  PRICE_DOWN: "急落",
  TOB: "TOB",
  CORPORATE: "企業イベント",
};

function NotificationRows({
  notifications,
  securityMap,
  readIds,
  onRead,
  onOpenSecurity,
  heldIds,
  compact = false,
}: {
  notifications: PortfolioNotification[];
  securityMap: Map<string, any>;
  readIds: Set<string>;
  onRead: (id: string) => void;
  onOpenSecurity?: (id: string) => void;
  heldIds?: Set<string>;
  compact?: boolean;
}) {
  if (!notifications.length) {
    return (
      <div className="notification-empty">
        <Bell size={20} />
        <span>該当する通知はありません</span>
      </div>
    );
  }

  return (
    <div className={`notification-rows ${compact ? "compact" : ""}`}>
      {notifications.map((notice) => {
        const security = notice.securityId ? securityMap.get(notice.securityId) : null;
        const isHeld = notice.securityId ? heldIds?.has(notice.securityId) : false;
        const isRead = readIds.has(notice.id);
        const unread = !isRead;
        const canOpen = Boolean(onOpenSecurity && notice.securityId);
        const isUp = notice.type === "PRICE_UP" || notice.type === "LIMIT_UP";
        const isDown = notice.type === "PRICE_DOWN" || notice.type === "LIMIT_DOWN";
        const toneClass = isUp ? "up" : isDown ? "down" : "";

        return (
          <article
            key={notice.id}
            className={`notification-row ${isRead ? "read" : "unread"}`}
          >
            <div className="notification-header-line">
              <div className="notification-type-badge">
                <span className={`notification-tag ${toneClass}`}>
                  {notificationTypeLabel[notice.type] || notice.type}
                </span>
                {isHeld && <span className="notification-symbol-pill">保有</span>}
                <span className="notification-date">{dateJa(notice.occurredAt)}</span>
              </div>
              <div className="notification-status-indicator">
                {!isRead ? (
                  <span className="notification-unread-dot">未読</span>
                ) : (
                  <span className="notification-read-label">既読</span>
                )}
              </div>
            </div>

            <div className="notification-main-content">
              <div className="notification-title-bar">
                <strong className="notification-title">{notice.title}</strong>
                {security?.displaySymbol && (
                  <span className="notification-symbol-pill">{security.displaySymbol}</span>
                )}
              </div>
              <p className="notification-summary">{notice.summary}</p>
              {(notice.beforeQuantity != null ||
                (notice.beforeAverageCost != null && notice.afterAverageCost != null) ||
                (notice.beforeReferencePrice != null && notice.afterReferencePrice != null) ||
                notice.limitPrice != null ||
                notice.changeRatio != null ||
                notice.offerPrice != null) && (
                <div className="notification-facts-list">
                  {notice.beforeQuantity != null && (
                    <div className="notification-fact-chip">
                      <span>保有数:</span>
                      <strong>
                        {number.format(Number(notice.beforeQuantity))}株 → {number.format(Number(notice.afterQuantity))}株
                      </strong>
                    </div>
                  )}
                  {notice.beforeAverageCost != null && notice.afterAverageCost != null && (
                    <div className="notification-fact-chip">
                      <span>取得単価:</span>
                      <strong>
                        {money(Number(notice.beforeAverageCost), notice.currency)} → {money(Number(notice.afterAverageCost), notice.currency)}
                      </strong>
                    </div>
                  )}
                  {notice.beforeReferencePrice != null && notice.afterReferencePrice != null && (
                    <div className="notification-fact-chip">
                      <span>基準株価:</span>
                      <strong>
                        {money(Number(notice.beforeReferencePrice), notice.currency)} → {money(Number(notice.afterReferencePrice), notice.currency)}
                      </strong>
                    </div>
                  )}
                  {notice.limitPrice != null && (
                    <div className="notification-fact-chip">
                      <span>制限値段:</span>
                      <strong className={toneClass}>{money(Number(notice.limitPrice), notice.currency)}</strong>
                    </div>
                  )}
                  {notice.changeRatio != null && (
                    <div className="notification-fact-chip">
                      <span>騰落率:</span>
                      <strong className={toneClass}>{signedPercent(Number(notice.changeRatio))}</strong>
                    </div>
                  )}
                  {notice.offerPrice != null && (
                    <div className="notification-fact-chip">
                      <span>公開買付価格:</span>
                      <strong>{money(Number(notice.offerPrice), notice.currency)}</strong>
                    </div>
                  )}
                  {notice.expiresAt && (
                    <div className="notification-fact-chip">
                      <span>買付期限:</span>
                      <strong>{dateJa(notice.expiresAt)}</strong>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="notification-actions-footer">
              {unread && (
                <button
                  type="button"
                  className="notification-action-btn read-btn"
                  onClick={() => onRead(notice.id)}
                >
                  既読にする
                </button>
              )}
              {canOpen && (
                <button
                  type="button"
                  className="notification-action-btn detail-btn"
                  onClick={() => {
                    onRead(notice.id);
                    onOpenSecurity?.(notice.securityId);
                  }}
                >
                  銘柄詳細
                  <ChevronRight size={13} />
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function NotificationsView({
  notifications,
  securityMap,
  detailSecurityIds,
  readNotificationIds,
  onRead,
  onReadAll,
  onOpenSecurity,
}: any) {
  const [filter, setFilter] = useState<"ALL" | "CORPORATE" | "PRICE">("ALL");
  const readIds = useMemo(() => new Set<string>(readNotificationIds), [readNotificationIds]);
  const priceTypes = new Set<PortfolioNotification["type"]>(["LIMIT_UP", "LIMIT_DOWN", "PRICE_UP", "PRICE_DOWN"]);
  const filtered = notifications.filter(
    (notice: PortfolioNotification) =>
      filter === "ALL" || (filter === "PRICE" ? priceTypes.has(notice.type) : !priceTypes.has(notice.type))
  );
  const unread = notifications.filter((notice: PortfolioNotification) => !readIds.has(notice.id)).length;

  return (
    <div className="notification-page">
      <section className="notification-list panel">
        {filtered.length ? (
          <NotificationRows
            notifications={filtered}
            securityMap={securityMap}
            readIds={readIds}
            onRead={onRead}
            onOpenSecurity={onOpenSecurity}
            heldIds={detailSecurityIds}
          />
        ) : (
          <div className="notification-empty" role="status">
            <Bell size={24} />
            <strong>
              {filter === "PRICE"
                ? "値動き通知はありません"
                : filter === "CORPORATE"
                ? "企業イベントはありません"
                : "通知はありません"}
            </strong>
            <span>保有銘柄の株式分割・併合や急変動が発生した際に通知されます。</span>
          </div>
        )}
      </section>

      {/* Bottom Controls: Notification Filter Tabs & Mark All Read Button Dock in Single Row */}
      <div className="notification-bottom-controls" data-swipe-ignore="true">
        <div className="segmented notification-segmented" role="tablist" aria-label="通知種別">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "ALL"}
            className={filter === "ALL" ? "active" : ""}
            onClick={() => setFilter("ALL")}
          >
            すべて
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "CORPORATE"}
            className={filter === "CORPORATE" ? "active" : ""}
            onClick={() => setFilter("CORPORATE")}
          >
            企業イベント
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === "PRICE"}
            className={filter === "PRICE" ? "active" : ""}
            onClick={() => setFilter("PRICE")}
          >
            値動き
          </button>
        </div>

        {unread > 0 && (
          <button
            className="secondary-button notification-read-all-btn"
            type="button"
            onClick={onReadAll}
            aria-label={`すべて既読にする (${unread}件)`}
            title={`すべて既読にする (${unread}件)`}
          >
            <Check size={16} />
            <span>既読 ({unread})</span>
          </button>
        )}
      </div>
    </div>
  );
}

function DateRangeControl({ value, active, min, max, onApply }: { value: CustomDateRange | null; active: boolean; min: string; max: string; onApply: (value: CustomDateRange) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value?.from ?? min);
  const [to, setTo] = useState(value?.to ?? max);
  const openDialog = () => {
    const suggestedTo = value?.to ?? max;
    const suggestedFrom = shiftCalendarMonths(suggestedTo, -3);
    setFrom(value?.from ?? (suggestedFrom < min ? min : suggestedFrom));
    setTo(suggestedTo);
    setOpen(true);
  };
  const valid = Boolean(from && to && from <= to && from >= min && to <= max);
  return <><button type="button" className={`date-range-trigger ${active ? "active" : ""}`} aria-label="日付範囲を指定" aria-pressed={active} aria-haspopup="dialog" title={active && value ? `${value.from}–${value.to}` : "日付範囲を指定"} onClick={openDialog}><CalendarDays size={16}/></button>{open && <div className="date-range-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><form className="date-range-dialog" role="dialog" aria-modal="true" aria-labelledby="date-range-title" onSubmit={(event) => { event.preventDefault(); if (!valid) return; onApply({ from, to }); setOpen(false); }}><div className="modal-head"><div><span>DATE RANGE</span><h2 id="date-range-title">表示期間を指定</h2></div><button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="閉じる"><X size={18}/></button></div><div className="date-range-fields"><label>開始日<input type="date" value={from} min={min} max={to || max} onChange={(event) => setFrom(event.target.value)}/></label><span>—</span><label>終了日<input type="date" value={to} min={from || min} max={max} onChange={(event) => setTo(event.target.value)}/></label></div><div className="date-range-bounds">選択可能: {min.replaceAll("-", "/")}–{max.replaceAll("-", "/")}</div>{from > to && <p className="form-error">終了日は開始日以降にしてください。</p>}<div className="date-range-actions"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>キャンセル</button><button type="submit" className="trade-button" disabled={!valid}>適用</button></div></form></div>}</>;
}

const ALLOCATION_COLORS = ["#3f6d94", "#4f8068", "#827052", "#785f78", "#697680", "#8a5d54", "#557c82", "#7a8060"];

function AllocationChart({ holdings, cashValue, currency, amountsVisible = true }: { holdings: any[]; cashValue: number; currency: DisplayCurrency; amountsVisible?: boolean }) {
  const allocation = useMemo(() => {
    const rows = holdings
      .map((holding) => ({
        name: holding.security?.name ?? holding.securityId,
        legalName: holding.security?.legalName ?? holding.security?.name ?? holding.securityId,
        symbol: holding.security?.displaySymbol ?? "",
        value: Math.max(0, Number(holding.marketValue ?? 0)),
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);
    if (cashValue > 0) rows.push({ name: "現金", legalName: "現金", symbol: currency, value: cashValue });
    if (rows.length <= 8) return rows;
    const other = rows.slice(7).reduce((total, item) => total + item.value, 0);
    return [...rows.slice(0, 7), { name: "その他", legalName: "その他", symbol: `${rows.length - 7}銘柄`, value: other }];
  }, [cashValue, holdings]);

  const total = allocation.reduce((sum, item) => sum + item.value, 0);

  if (!allocation.length) {
    return <div className="empty-state">評価できる保有資産がありません</div>;
  }

  return (
    <div className="allocation-view" aria-label="資産構成比率" data-swipe-ignore="true">
      <div className="allocation-chart-wrap" data-swipe-ignore="true">
        <LightweightDonutChart items={allocation.map((item, index) => ({ name: item.name, value: item.value, color: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length] }))}/>
        <div className="allocation-center">
          <strong>{amountsVisible ? shortMoney(total, currency) : HIDDEN_AMOUNT}</strong>
          <span>資産総額</span>
        </div>
      </div>

      <div className="allocation-legend-list">
        {allocation.map((item, index) => {
          const pct = total ? (item.value / total) * 100 : 0;
          return (
            <div className="allocation-legend-row" key={`${item.name}-${item.symbol}`}>
              <div className="allocation-legend-item-info">
                <i style={{ background: ALLOCATION_COLORS[index % ALLOCATION_COLORS.length] }} />
                <div className="allocation-legend-names">
                  <strong title={item.legalName}>{item.name}</strong>
                  <small>{item.symbol}</small>
                </div>
              </div>
              <div className="allocation-legend-item-values">
                <strong className="allocation-legend-pct">{pct.toFixed(1)}%</strong>
                <span className="allocation-legend-val" aria-label={amountsVisible ? undefined : "金額非表示"}>
                  {amountsVisible ? compactMoney(item.value, currency) : HIDDEN_AMOUNT}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ACCENT_THEMES: Array<{ id: AccentTheme; label: string }> = [
  { id: "graphite", label: "グラファイト" },
  { id: "blue", label: "ブルー" },
  { id: "forest", label: "フォレスト" },
  { id: "plum", label: "プラム" },
];

function SettingsView({ seed, exportCsv, exportJson, onEncryptedBackup, allowPlaintextExport, onLock, onLogout, dark, setDark, accentTheme, setAccentTheme, quoteStatus, benchmarkStatus, historyStatus, historyQuality, historyCacheMeta, quoteHealth, historyHealth, dataReconciled, corporateActionCount, latestQuoteAt, apiUsage, benchmarkCount, quoteCount, intradayCount, historyCount, persistenceMode, allowPersistentMarketCache, serverOrigin, autoRefresh, setAutoRefresh, updateFrequency, setUpdateFrequency, effectiveUpdateMinutes, hideScrollbar, setHideScrollbar, displayCurrency, marketFilter, currentUsdJpy, notificationCount, priceAlertThreshold, setPriceAlertThreshold }: any) {
  const [pendingAction, setPendingAction] = useState<DataSecurityAction | null>(null);
  const latestRequest = [apiUsage.lastQuoteRequest, apiUsage.lastBenchmarkRequest, apiUsage.lastHistoryRequest, apiUsage.lastSearchRequest].filter(Boolean).sort().at(-1) as string | undefined;
  const marketScope = portfolioFilterLabel(marketFilter);
  const historyIntegrity = historyQuality?.status === "valid" ? "正常" : historyQuality ? "要確認" : "未検査";
  const systemHealthy = dataReconciled && historyQuality?.status !== "invalid" && quoteHealth.failedIds.length === 0;
  const confirmation = pendingAction ? {
    "encrypted-backup": {
      title: "バックアップしますか？",
      description: "次の画面でパスフレーズを設定します。",
      confirmLabel: "進む",
      danger: false,
    },
    "export-csv": {
      title: "CSVを書き出しますか？",
      description: "暗号化されていないファイルを保存します。",
      confirmLabel: "書き出す",
      danger: false,
    },
    "export-json": {
      title: "JSONを書き出しますか？",
      description: "暗号化されていないファイルを保存します。",
      confirmLabel: "書き出す",
      danger: false,
    },
    lock: {
      title: "ロックしますか？",
      description: "解除にはGoogleアカウントが必要です。",
      confirmLabel: "ロック",
      danger: false,
    },
    logout: {
      title: "ログアウトしますか？",
      description: "この端末のセッションを終了します。",
      confirmLabel: "ログアウト",
      danger: true,
    },
  }[pendingAction] : null;

  useEffect(() => {
    if (!pendingAction) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingAction(null);
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [pendingAction]);

  const confirmPendingAction = () => {
    const action = pendingAction;
    setPendingAction(null);
    if (action === "encrypted-backup") onEncryptedBackup?.(seed);
    if (action === "export-csv") exportCsv();
    if (action === "export-json") exportJson();
    if (action === "lock") void onLock?.();
    if (action === "logout") void onLogout?.();
  };

  return <div className="settings-page-container">
    <div className="settings-page">
      <section className="settings-card panel" aria-labelledby="settings-preferences-title">
        <header className="settings-card-header">
          <div><h2 id="settings-preferences-title">一般</h2></div>
        </header>
        <div className="settings-rows">
          <div className="settings-row">
            <div><strong>ダークモード</strong></div>
            <button type="button" className="toggle" data-on={dark} onClick={() => setDark(!dark)} aria-label="ダークモード" aria-pressed={dark}><i/></button>
          </div>
          <div className="settings-row settings-theme-row">
            <div><strong>テーマカラー</strong></div>
            <div className="theme-options" role="radiogroup" aria-label="テーマカラー">{ACCENT_THEMES.map((theme) => <button type="button" role="radio" aria-checked={accentTheme === theme.id} className={accentTheme === theme.id ? "active" : ""} key={theme.id} onClick={() => setAccentTheme(theme.id)} aria-label={theme.label} title={theme.label}><i data-color={theme.id}/><span>{theme.label}</span></button>)}</div>
          </div>
          <div className="settings-row">
            <div><strong>スクロールバーを隠す</strong></div>
            <button type="button" className="toggle" data-on={hideScrollbar} onClick={() => setHideScrollbar(!hideScrollbar)} aria-label="スクロールバーを隠す" aria-pressed={hideScrollbar}><i/></button>
          </div>
          <div className="settings-row">
            <div><strong>価格を自動更新</strong></div>
            <button type="button" className="toggle" data-on={autoRefresh} onClick={() => setAutoRefresh(!autoRefresh)} aria-label="価格を自動更新" aria-pressed={autoRefresh}><i/></button>
          </div>
          <div className="settings-row">
            <div><strong>更新間隔</strong></div>
            <select className="settings-select" value={updateFrequency} onChange={(event) => setUpdateFrequency(Number(event.target.value) as UpdateFrequency)} disabled={!autoRefresh} aria-label="価格の更新間隔">{UPDATE_FREQUENCIES.map((minutes) => <option key={minutes} value={minutes}>{minutes}分</option>)}</select>
          </div>
          <div className="settings-row">
            <div>
              <strong>変動通知の基準値</strong>
              <small>前日比の急変動として検知する閾値</small>
            </div>
            <select className="settings-select" value={priceAlertThreshold} onChange={(event) => setPriceAlertThreshold(Number(event.target.value))} aria-label="前日比変動通知の基準値">{PRICE_ALERT_THRESHOLDS.map((percent) => <option key={percent} value={percent}>±{percent}%</option>)}</select>
          </div>
        </div>
      </section>

      <section className="settings-card panel" aria-labelledby="settings-data-title">
        <header className="settings-card-header">
          <div><h2 id="settings-data-title">データとセキュリティ</h2></div>
          <span className={`settings-state ${persistenceMode === "cloud" ? "ready" : ""}`}>{persistenceMode === "cloud" ? "クラウド" : "端末内"}</span>
        </header>
        <div className="settings-stats" aria-label="保存データの概要">
          <div><strong>{seed.transactions.length.toLocaleString("ja-JP")}</strong><span>取引</span></div>
          <div><strong>{seed.securities.length.toLocaleString("ja-JP")}</strong><span>銘柄</span></div>
          <div><strong>{notificationCount.toLocaleString("ja-JP")}</strong><span>通知</span></div>
        </div>
        <div className="settings-actions">
          {onEncryptedBackup && <button className="trade-button" onClick={() => setPendingAction("encrypted-backup")}><ShieldCheck size={14}/>バックアップ</button>}
          {allowPlaintextExport && <><button className="secondary-button" onClick={() => setPendingAction("export-csv")}><Download size={14}/>CSV</button><button className="secondary-button" onClick={() => setPendingAction("export-json")}><Download size={14}/>JSON</button></>}
        </div>
        {onLock && onLogout && <div className="settings-session"><button type="button" className="secondary-button" onClick={() => setPendingAction("lock")}><LockKeyhole size={14}/>ロック</button><button type="button" className="danger-button" onClick={() => setPendingAction("logout")}><LogOut size={14}/>ログアウト</button></div>}
      </section>

      <details className="settings-card settings-system panel">
        <summary>
          <div><strong>システム情報</strong></div>
          <span className={`settings-state ${systemHealthy ? "ready" : "warning"}`}>{systemHealthy ? "正常" : "要確認"}</span>
        </summary>
        <div className="system-status-grid">
          <div><span>集計</span><strong className={dataReconciled ? "" : "down"}>{dataReconciled ? "正常" : "不一致"}</strong></div>
          <div><span>価格</span><strong>{quoteHealth.returned || quoteCount}/{quoteHealth.requested || seed.securities.length}銘柄</strong></div>
          <div><span>日足</span><strong>{historyCount.toLocaleString("ja-JP")}本</strong></div>
          <div><span>市場指標</span><strong>{benchmarkCount}/5件</strong></div>
          <div><span>履歴検査</span><strong>{historyIntegrity}</strong></div>
          <div><span>株式分割</span><strong>{corporateActionCount}件</strong></div>
        </div>
        <dl className="system-details">
          <div><dt>表示</dt><dd>{marketScope} · {displayCurrency === "NATIVE" ? "現地通貨" : displayCurrency}{currentUsdJpy ? ` · USD/JPY ${benchmarkNumber.format(currentUsdJpy)}` : ""}</dd></div>
          <div><dt>最終価格</dt><dd>{latestQuoteAt ? shortDateTimeJa(latestQuoteAt) : "未取得"} · {quoteStatus}</dd></div>
          <div><dt>データ状態</dt><dd>指標 {benchmarkStatus} · 履歴 {historyStatus} · 日中足 {intradayCount.toLocaleString("ja-JP")}本</dd></div>
          <div><dt>フォールバック</dt><dd>価格 {quoteHealth.fallbackIds.length}件 · 履歴 {historyHealth.fallbackIds.length}件 · 未取得 {quoteHealth.failedIds.length}件</dd></div>
          <div><dt>保存</dt><dd>{allowPersistentMarketCache ? "端末キャッシュ有効" : "メモリのみ"}{historyCacheMeta?.savedAt ? ` · ${shortDateTimeJa(historyCacheMeta.savedAt)}` : ""}</dd></div>
          <div><dt>通信</dt><dd>価格 {apiUsage.quoteRequests} · 指標 {apiUsage.benchmarkRequests} · 履歴 {apiUsage.historyRequests} · 検索 {apiUsage.searchRequests}{latestRequest ? ` · 最終 ${timeJa(latestRequest)}` : ""}</dd></div>
          <div><dt>接続先</dt><dd>{serverOrigin}</dd></div>
        </dl>
      </details>
    </div>
    {confirmation && createPortal(<div className="modal-layer delete-confirm-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPendingAction(null)}>
      <section className={`delete-confirm settings-confirm${confirmation.danger ? " danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="settings-confirm-title" aria-describedby="settings-confirm-description">
        <div className="delete-confirm-heading"><h2 id="settings-confirm-title">{confirmation.title}</h2></div>
        <p id="settings-confirm-description">{confirmation.description}</p>
        <div className="delete-confirm-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setPendingAction(null)}>キャンセル</button><button type="button" className={confirmation.danger ? "danger-button" : "trade-button"} onClick={confirmPendingAction}>{confirmation.confirmLabel}</button></div>
      </section>
    </div>, document.body)}
  </div>;
}

function PortfolioChart({ history, historyStatus, compact = false, zeroBased = false, showCapital = true, currency = "JPY", amountsVisible = true, detailsEnabled = false }: { history: Array<{ date: string; value: number; capital: number }>; historyStatus: MarketStatus; compact?: boolean; zeroBased?: boolean; showCapital?: boolean; currency?: DisplayCurrency; amountsVisible?: boolean; detailsEnabled?: boolean }) {
  const dateSpan = history.length > 1 ? new Date(history.at(-1)!.date).getTime() - new Date(history[0].date).getTime() : 0;
  const tickLabel = (value: string) => value.includes("T") ? dateSpan > 36 * 60 * 60_000 ? shortDateTimeJa(value) : timeJa(value) : dateSpan <= 45 * 24 * 60 * 60_000 ? value.slice(5, 10).replace("-", "/") : value.slice(2, 7);
  const yDomain = dynamicChartDomain(history.map((point) => point.value), showCapital ? history.map((point) => point.capital) : [], { zeroBased, minimumSpread: 1 });
  const axisSpread = yDomain[1] - yDomain[0];
  const yTickLabel = (value: number) => {
    const absolute = Math.abs(value);
    const roundedUnit = (scaledValue: number) => new Intl.NumberFormat("ja-JP", { maximumSignificantDigits: 2 }).format(scaledValue);
    if (compact && currency === "JPY" && absolute >= 100_000_000) return `${roundedUnit(value / 100_000_000)}億`;
    if (compact && currency === "JPY" && absolute >= 10_000) return `${roundedUnit(value / 10_000)}万`;
    if (compact && currency === "USD" && absolute >= 1_000_000) return `${roundedUnit(value / 1_000_000)}M`;
    if (compact && currency === "USD" && absolute >= 1_000) return `${roundedUnit(value / 1_000)}K`;
    if (compact) return roundedUnit(value);
    if (currency === "JPY" && absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(axisSpread < 100_000_000 ? 2 : 1)}億`;
    if (currency === "JPY" && absolute >= 10_000) return `${compactNumber(value / 10_000)}万`;
    if (currency === "USD" && absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (currency === "USD" && absolute >= 1_000) return `${compactNumber(value / 1_000)}K`;
    return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: currency === "USD" || axisSpread < 100 ? 2 : 0 }).format(value);
  };
  const chartSeries = useMemo(() => [
    ...(showCapital ? [{ key: "capital", name: "投資元本", read: (point: { capital: number }) => point.capital, stroke: "var(--muted)", strokeWidth: 1, strokeDasharray: "3 3" }] : []),
    { key: "value", name: "評価額", read: (point: { value: number }) => point.value, stroke: "var(--accent)", strokeWidth: 1.7, fillOpacity: 0.13 },
  ], [showCapital]);
  return history.length ? <LightweightAreaChart
    data={history}
    domain={yDomain}
    series={chartSeries}
    xValue={(point) => point.date}
    xTickFormatter={tickLabel}
    yTickFormatter={yTickLabel}
    tickCount={compact ? 4 : 5}
    yAxisWidth={amountsVisible ? compact ? 42 : 52 : 8}
    xAxisHeight={compact ? 24 : 30}
    tickMargin={compact ? 4 : 5}
    minTickGap={compact ? 40 : 50}
    top={compact ? 6 : 16}
    right={compact ? 6 : 8}
    minHeight={compact ? 120 : 220}
    showYAxis={amountsVisible}
    detailsEnabled={detailsEnabled}
    tooltipContent={(point) => <HistoryTooltip point={point} showCapital={showCapital} currency={currency} amountsVisible={amountsVisible}/>}
    ariaLabel="ポートフォリオ評価額の推移"
  /> : <div className="empty-state"><RefreshCw size={15} className={historyStatus === "loading" || historyStatus === "idle" ? "spin" : ""}/><span>{historyStatus === "loading" || historyStatus === "idle" ? "履歴取得中" : "履歴なし"}</span></div>;
}

function StockPriceChart({ history, historyStatus, currency = "JPY", compact = false, zeroBased = false, label = "株価", detailsEnabled = false }: { history: Array<{ date: string; price: number }>; historyStatus: MarketStatus; currency?: string; compact?: boolean; zeroBased?: boolean; label?: string; detailsEnabled?: boolean }) {
  const dateSpan = history.length > 1 ? new Date(history.at(-1)!.date).getTime() - new Date(history[0].date).getTime() : 0;
  const tickLabel = (value: string) => dateSpan <= 45 * 24 * 60 * 60_000 ? value.slice(5, 10).replace("-", "/") : value.slice(2, 7);
  const yDomain = dynamicChartDomain(history.map((point) => point.price), [], { zeroBased, nonNegative: true, minimumSpread: 0.01 });
  const axisSpread = yDomain[1] - yDomain[0];
  const yTickLabel = (value: number) => {
    if (currency === "JPY" && Math.abs(value) >= 10_000) return `${compactNumber(value / 10_000)}万`;
    return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: currency === "JPY" ? (axisSpread < 100 ? 2 : 0) : axisSpread < 10 ? 2 : 1 }).format(value);
  };
  const positive = (history.at(-1)?.price ?? 0) >= (history[0]?.price ?? 0);
  const tone = positive ? "var(--up)" : "var(--down)";
  const chartSeries = useMemo(() => [{ key: "price", name: label, read: (point: { price: number }) => point.price, stroke: tone, strokeWidth: 1.8, fillOpacity: 0.16 }], [label, tone]);
  return history.length ? <LightweightAreaChart
    data={history}
    domain={yDomain}
    series={chartSeries}
    xValue={(point) => point.date}
    xTickFormatter={tickLabel}
    yTickFormatter={yTickLabel}
    tickCount={5}
    yAxisWidth={compact ? 46 : 52}
    xAxisHeight={30}
    tickMargin={5}
    minTickGap={compact ? 38 : 50}
    top={compact ? 8 : 16}
    right={compact ? 4 : 8}
    minHeight={compact ? 100 : 200}
    detailsEnabled={detailsEnabled}
    tooltipContent={(point) => <PriceTooltip point={point} label={label} currency={currency} tone={tone}/>}
    ariaLabel={`${label}の推移`}
  /> : <div className="empty-state"><RefreshCw size={15} className={historyStatus === "loading" || historyStatus === "idle" ? "spin" : ""}/><span>{historyStatus === "loading" || historyStatus === "idle" ? "履歴取得中" : `${label}履歴なし`}</span></div>;
}

function HistoryTooltip({ point, showCapital, currency, amountsVisible = true }: { point: { date: string; value: number; capital: number }; showCapital: boolean; currency: DisplayCurrency; amountsVisible?: boolean }) {
  const displayLabel = point.date.includes("T") ? shortDateTimeJa(point.date) : point.date;
  return <div className="chart-tooltip"><span>{displayLabel}</span>{showCapital && <div><i style={{background:"var(--muted)"}}/><small>投資元本</small><strong aria-label={amountsVisible ? undefined : "金額非表示"}>{amountsVisible ? money(point.capital, currency) : HIDDEN_AMOUNT}</strong></div>}<div><i style={{background:"var(--accent)"}}/><small>評価額</small><strong aria-label={amountsVisible ? undefined : "金額非表示"}>{amountsVisible ? money(point.value, currency) : HIDDEN_AMOUNT}</strong></div></div>;
}

function PriceTooltip({ point, label, currency, tone }: { point: { date: string; price: number }; label: string; currency: string; tone: string }) {
  return <div className="chart-tooltip"><span>{point.date}</span><div><i style={{background:tone}}/><small>{label}</small><strong>{money(point.price, currency)}</strong></div></div>;
}
