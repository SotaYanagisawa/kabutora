import corporateActionSeed from "../../data/corporate-actions.json";
import marketNoticeSeed from "../../data/market-notices.json";
import type { CorporateAction, MarketQuote } from "@kabutora/domain";
import type { ExternalMarketNotice, PortfolioNotification } from "../../lib/portfolio/portfolio-notifications";
import {
  Bell,
  Coins,
  FileClock,
  LayoutDashboard,
  Search,
  Settings,
} from "lucide-react";
import type { AccentTheme, RangeKey, UpdateFrequency, View } from "./types";

export const NAV_ITEMS: Array<{ id: View; label: string; shortLabel: string; icon: typeof LayoutDashboard }> = [
  { id: "activity", label: "取引履歴", shortLabel: "取引", icon: FileClock },
  { id: "watchlist", label: "銘柄検索", shortLabel: "検索", icon: Search },
  { id: "overview", label: "一覧", shortLabel: "一覧", icon: LayoutDashboard },
  { id: "dividends", label: "配当金", shortLabel: "配当", icon: Coins },
  { id: "notifications", label: "通知", shortLabel: "通知", icon: Bell },
  { id: "settings", label: "設定", shortLabel: "設定", icon: Settings },
];

export const MOBILE_NAV_ITEMS = NAV_ITEMS;
export const MOBILE_TOUCH_NAVIGATION_ORDER = MOBILE_NAV_ITEMS.map((item) => item.id);
export const MOBILE_VIEW_INDEX: Record<string, number> = {
  activity: 0,
  watchlist: 1,
  overview: 2,
  dividends: 3,
  notifications: 4,
  settings: 5,
};

export const PORTFOLIO_RANGES: RangeKey[] = ["1D", "1W", "1M", "3M", "YTD", "ALL"];
export const UPDATE_FREQUENCIES: UpdateFrequency[] = [10, 15, 30, 60];
/** Returning to a visible app refreshes prices when the last load is older than this. */
export const RESUME_REFRESH_MS = 30 * 1000;
export const HISTORY_NETWORK_REVALIDATE_MS = 6 * 60 * 60 * 1000;
export const HISTORY_INTEGRITY_CHECK_MS = 15 * 60 * 1000;
export const PULL_REFRESH_THRESHOLD = 64;
export const PULL_REFRESH_MAX = 100;
export const TOUCH_NAVIGATION_LOCK_PX = 12;
export const MOBILE_LAYOUT_QUERY = "(max-width: 840px), (max-height: 500px) and (orientation: landscape)";
export const PERFORMANCE_DERIVATION_VERSION = "market-value-v5-separated-dividends";
export const FX_SECURITY_ID = "sec-fx-usdjpy";
export const MARKET_CACHE_KEY = "market-v8";
export const HISTORY_CACHE_KEY = "history-v11";
export const DISTRIBUTION_CACHE_KEY = "distributions-v1";
export const DISTRIBUTION_NETWORK_REVALIDATE_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_AMOUNTS_VISIBLE_KEY = "kabutora-summary-amounts-visible";
export const HIDE_SCROLLBAR_KEY = "kabutora-hide-scrollbar";
export const PRICE_ALERT_THRESHOLD_KEY = "kabutora-price-alert-threshold";
export const SUMMARY_MARKET_FILTER_KEY = "kabutora-summary-market-filter";
export const LEGACY_MARKET_FILTER_KEY = "kabutora-market-filter";
export const SUMMARY_BROKER_FILTER_KEY = "kabutora-summary-broker-filter";
export const SUMMARY_RANGE_KEY = "kabutora-summary-range";
export const SUMMARY_CUSTOM_RANGE_KEY = "kabutora-summary-custom-range";
export const DIVIDEND_MARKET_FILTER_KEY = "kabutora-dividend-market-filter";
export const DIVIDEND_DISPLAY_CURRENCY_KEY = "kabutora-dividend-display-currency";
export const DIVIDEND_PERIOD_KEY = "kabutora-dividend-period";
export const DIVIDEND_TAX_MODE_KEY = "kabutora-dividend-tax-mode";
export const DIVIDEND_TAB_KEY = "kabutora-dividend-tab";

export const HIDDEN_AMOUNT = "••••••";
export const LEGACY_MARKET_CACHE_KEYS = ["kabutora-market-cache-v5", "kabutora-market-cache-v4", "kabutora-market-cache-v3"];
export const LEGACY_HISTORY_CACHE_KEYS = [
  "history-v10",
  "history-v9",
  "kabutora-history-cache-v8",
  "kabutora-history-cache-v7",
  "kabutora-history-cache-v6",
  "kabutora-history-cache-v5",
  "kabutora-history-cache-v4",
  "kabutora-history-cache-v3",
  "kabutora-history-cache-v2",
];

export const rangeLabel = (range: RangeKey) => range;

export const freshnessLabel: Record<MarketQuote["freshness"], string> = {
  live: "LIVE",
  near_live: "NEAR LIVE",
  delayed: "DELAYED",
  cached: "CACHED",
  stale: "STALE",
  manual: "MANUAL",
};

export const seededActions = corporateActionSeed.actions as CorporateAction[];
export const seededMarketNotices = marketNoticeSeed.notices as ExternalMarketNotice[];
export const notificationTypes = new Set<PortfolioNotification["type"]>([
  "SPLIT",
  "REVERSE_SPLIT",
  "LIMIT_UP",
  "LIMIT_DOWN",
  "PRICE_UP",
  "PRICE_DOWN",
  "TOB",
  "CORPORATE",
]);

export const ALLOCATION_COLORS = ["#3f6d94", "#4f8068", "#827052", "#785f78", "#697680", "#8a5d54", "#557c82", "#7a8060"];

export const ACCENT_THEMES: Array<{ id: AccentTheme; label: string }> = [
  { id: "graphite", label: "グラファイト" },
  { id: "blue", label: "ブルー" },
  { id: "forest", label: "フォレスト" },
  { id: "plum", label: "プラム" },
];

export const APP_VERSION = "0.1.0";
export const APP_RELEASE_DATE = "2026年9月4日";
