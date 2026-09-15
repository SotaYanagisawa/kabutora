import type {
  CorporateAction,
  DerivedHolding,
  DistributionEvent,
  IntradayBar,
  LedgerTransaction,
  MarketBar,
  PortfolioSummary,
} from "@kabutora/domain";
import type { PortfolioNotification } from "@/lib/portfolio-notifications";
import type { HistoryQuality, PackedHistorySeries } from "@/lib/market-history";
import type {
  DistributionCoverage,
  MarketDistributionBatchResult,
  ServerBenchmark,
  ServerMarketSnapshot,
  ServerRemoteQuote,
} from "@/lib/server-market-types";
import type { MarketSessionStatus } from "@/lib/market-session";

export type Seed = {
  portfolio: { id: string; name: string; baseCurrency: string; defaultCostBasisMethod: string };
  accounts: Array<{
    id: string;
    name: string;
    broker: string;
    accountType: string;
    country?: string;
    defaultCurrency?: string;
    archivedAt?: string;
    updatedAt?: string;
    version?: number;
  }>;
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
  watchlist?: SearchSecurity[];
  preferences?: UserPreferences;
  /** Encrypted with the portfolio; checkpoints prevent replay after interrupted compaction. */
  sync?: { appliedEventIds: string[]; deletedTransactions?: Record<string, number>; watchlistSequence?: number; preferenceSequences?: Record<string, number> };
  importWarnings: Array<{ row: number; ticker: string; message: string }>;
};

export type RemoteQuote = ServerRemoteQuote;
export type MarketStatus = "idle" | "loading" | "ready" | "partial" | "error";

export type QuoteResponse = {
  generatedAt?: string;
  marketSessions?: MarketSessionStatus[];
  quotes: RemoteQuote[];
  intraday: IntradayBar[];
  failures: Array<{ securityId: string; symbol: string; message: string }>;
  coverage: { requested: number; returned: number; fresh: number; stale: number; suspect: number };
};

export type HistoryResponse = {
  generatedAt?: string;
  marketSessions?: MarketSessionStatus[];
  bars: MarketBar[];
  corporateActions: CorporateAction[];
  distributions?: DistributionEvent[];
  inceptionDates?: Record<string, string>;
  quality?: HistoryQuality;
  failures: Array<{ securityId: string; symbol: string; message: string }>;
  coverage: { requested: number; returned: number };
};

export type Benchmark = ServerBenchmark;
export type BenchmarkResponse = {
  generatedAt?: string;
  marketSessions?: MarketSessionStatus[];
  benchmarks: Benchmark[];
  failures: Array<{ id: string; message: string }>;
};

export type SearchSecurity = Seed["securities"][number] & { exchangeLabel?: string };
export type DashboardSecurity = Omit<SearchSecurity, "providerSymbols"> & {
  providerSymbols?: SearchSecurity["providerSymbols"];
  legalName?: string;
  nativeCurrency?: string;
  symbol?: string;
  quote?: RemoteQuote;
};
export type DashboardTransaction = Seed["transactions"][number] & {
  /** Legacy import fields retained for display compatibility. */
  currency?: string;
  priceUnit?: string | number;
};
export type DashboardHolding = DerivedHolding & {
  security: DashboardSecurity;
  quote?: RemoteQuote;
  /** Value normalized to the active portfolio summary currency. */
  summaryMarketValue?: string | null;
};
export type DashboardHistoryPoint = {
  date: string;
  value: number;
  dividendAdjustedValue?: number;
  capital: number;
};
export type DashboardSummary = PortfolioSummary;
export type SecurityLookup = ReadonlyMap<string, DashboardSecurity>;
export type DashboardAccount = Seed["accounts"][number];
export type AccountLookup = ReadonlyMap<string, DashboardAccount>;
export type View = "overview" | "watchlist" | "security" | "activity" | "performance" | "dividends" | "notifications" | "settings";
export type RangeKey = "1D" | "1W" | "1M" | "3M" | "YTD" | "ALL" | "CUSTOM";
export type CustomDateRange = { from: string; to: string };
export type SecurityChartMode = "position" | "price";
export type UpdateFrequency = 10 | 15 | 30 | 60;
export type AccentTheme = "graphite" | "blue" | "forest" | "plum";
export type DisplayCurrency = "JPY" | "USD" | "NATIVE";
export type HistoryCacheMeta = { savedAt: string; checksum: string; integrityMismatch?: boolean };
export type FetchHealth = { requested: number; returned: number; failedIds: string[]; fallbackIds: string[]; updatedAt: string | null };
export type PackedIntradaySeries = Record<string, {
  provider: string;
  rows: Array<[timestamp: string, price: string, venueCode?: string, session?: IntradayBar["session"]]>;
}>;

export type MarketCachePayload = {
  schemaVersion: number;
  savedAt: string;
  quotes: Record<string, RemoteQuote>;
  benchmarks?: Benchmark[];
  intraday?: IntradayBar[];
  intradaySeries?: PackedIntradaySeries;
};

export type HistoryCachePayload = {
  schemaVersion: number;
  savedAt?: string;
  checksum?: string;
  derivationVersion?: string;
  bars?: MarketBar[];
  series?: PackedHistorySeries;
  corporateActions: CorporateAction[];
  distributions?: DistributionEvent[];
  inceptionDates?: Record<string, string>;
};

export type DistributionResponse = MarketDistributionBatchResult;
export type DistributionCachePayload = {
  schemaVersion: number;
  savedAt: string;
  distributions: DistributionEvent[];
  coverage: DistributionCoverage[];
};

export type UserPreferences = {
  theme?: "light" | "dark";
  accentTheme?: AccentTheme;
  autoRefresh?: boolean;
  updateFrequency?: UpdateFrequency;
  displayCurrency?: DisplayCurrency;
  summaryMarketFilter?: "ALL" | "JP" | "US" | "FUNDS_INDEXES";
  summaryBrokerFilter?: string;
  dividendMarketFilter?: "ALL" | "JP" | "US" | "FUNDS_INDEXES";
  dividendDisplayCurrency?: DisplayCurrency;
  dividendPeriod?: string;
  dividendTaxMode?: "gross" | "net";
  dividendActiveTab?: "securities" | "history";
  summaryAmountsVisible?: boolean;
  hideScrollbar?: boolean;
  summaryRange?: RangeKey;
  summaryCustomRange?: CustomDateRange | null;
  priceAlertThreshold?: number;
  acknowledgedActions?: string[];
  readNotifications?: string[];
  notificationHistory?: PortfolioNotification[];
  lastUsdJpy?: number;
  updatedAt?: string;
  /** Per-setting edit clocks travel inside the encrypted preference event. */
  preferenceSequences?: Record<string, number>;
};

export type TouchGesture = {
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

export type SwipePhase = "idle" | "dragging" | "settling";
export type DataSecurityAction = "encrypted-backup" | "export-csv" | "export-json" | "lock" | "logout";

export type DashboardProps = {
  seed: Seed;
  initialServerTimeMs?: number;
  initialMarketSessions?: MarketSessionStatus[];
  initialMarketSnapshot?: ServerMarketSnapshot | null;
  persistenceMode?: "local" | "cloud";
  onTransactionsChange?: (transactions: Seed["transactions"]) => Promise<void> | void;
  onAccountsChange?: (accounts: Seed["accounts"]) => Promise<void> | void;
  onSecuritiesChange?: (securities: Seed["securities"]) => Promise<void> | void;
  onWatchlistChange?: (watchlist: SearchSecurity[]) => Promise<void> | void;
  onPreferencesChange?: (preferences: UserPreferences) => Promise<void> | void;
  preferenceNamespace?: string;
  onEncryptedBackup?: (seed: Seed) => void;
  onRestoreBackup?: (file: File) => void;
  allowPlaintextExport?: boolean;
  allowPersistentMarketCache?: boolean;
  onLock?: () => Promise<void> | void;
  onLogout?: () => Promise<void> | void;
  onStartupReady?: () => void;
};
