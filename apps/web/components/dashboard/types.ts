import type { Benchmark as MarketBenchmark, Session } from "@kabutora/domain/market";
import type { PortfolioNotification } from "@kabutora/domain/notifications";
import type { DividendReceipt, HistoryPoint, Holding, Summary } from "@kabutora/domain/portfolio";

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
  transactions: Array<{
    id: string;
    accountId: string;
    securityId: string | null;
    type: "BUY" | "SELL" | "TRANSFER_IN" | "DIVIDEND" | "DEPOSIT" | "WITHDRAWAL";
    tradeDate: string;
    quantity: string | null;
    pricePerShare: string | null;
    grossAmount: string | null;
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

export type MarketStatus = "idle" | "loading" | "ready" | "partial" | "error";
export type Freshness = "live" | "near_live" | "delayed" | "cached" | "stale" | "manual";

/** A market quote prepared for display (prices converted to the row's currency where applicable). */
export type DisplayQuote = {
  securityId: string;
  currency: string;
  exchangeMic?: string;
  exchangeLabel?: string;
  shortName?: string;
  longName?: string;
  brandName?: string;
  price: number;
  previousRegularClose: number | null;
  dayHigh?: number;
  dayLow?: number;
  dayVolume?: number;
  marketTimestamp: string;
  fetchedAt: string;
  freshness: Freshness;
  session: Session;
  priceType: "last_trade" | "official_close" | "delayed_last";
  venueCode: string;
};
/** Kept name: views historically called display quotes "remote" quotes. */
export type RemoteQuote = DisplayQuote;

export type Benchmark = MarketBenchmark;
export type SearchSecurity = Seed["securities"][number] & { exchangeLabel?: string };
/** A ledger/searched security with display names and its native-currency quote. */
export type MarketSecurity = SearchSecurity & {
  legalName?: string;
  nativeCurrency?: string;
  quote?: DisplayQuote;
};
export type DashboardSecurity = Omit<SearchSecurity, "providerSymbols"> & {
  providerSymbols?: SearchSecurity["providerSymbols"];
  legalName?: string;
  nativeCurrency?: string;
  symbol?: string;
  quote?: DisplayQuote;
};
export type DashboardTransaction = Seed["transactions"][number] & {
  /** Legacy import fields retained for display compatibility. */
  currency?: string;
  priceUnit?: string | number;
};
export type DashboardHolding = Holding & {
  security: DashboardSecurity;
  /** Value in the portfolio summary currency (differs from marketValue in NATIVE mode). */
  summaryMarketValue?: number | null;
};
export type DashboardHistoryPoint = HistoryPoint;
export type DashboardSummary = Summary;
export type DashboardReceipt = DividendReceipt;
export type SecurityLookup = ReadonlyMap<string, DashboardSecurity>;
export type DashboardAccount = Seed["accounts"][number];
export type AccountLookup = ReadonlyMap<string, DashboardAccount>;
export type View = "overview" | "watchlist" | "security" | "activity" | "performance" | "dividends" | "notifications" | "settings";
export type RangeKey = "1D" | "1W" | "1M" | "3M" | "YTD" | "ALL" | "CUSTOM";
export type CustomDateRange = { from: string; to: string };
export type SecurityChartMode = "position" | "price";
/** Seconds between automatic price updates while a market is open. */
export type UpdateFrequency = 10 | 15 | 30 | 60;
export type AccentTheme = "graphite" | "blue" | "forest" | "plum";
export type DisplayCurrency = "JPY" | "USD" | "NATIVE";

/** Market data health shown in Settings. */
export type MarketDiagnostics = {
  quoteStatus: MarketStatus;
  historyStatus: MarketStatus;
  pricedCount: number;
  unpricedCount: number;
  catalogCount: number;
  historyCount: number;
  historyPending: number;
  splitAdjustedCount: number;
  ledgerIssues: number;
  benchmarkCount: number;
  updatedAt: number | null;
  currentUsdJpy: number | null;
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
export type DataSecurityAction = "encrypted-backup" | "export-csv" | "export-json" | "logout";

export type DashboardProps = {
  seed: Seed;
  initialServerTimeMs?: number;
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
  onLogout?: () => Promise<void> | void;
  onStartupReady?: () => void;
};

/** Outcome of one market snapshot load, for the manual-refresh toast. */
export type MarketLoadResult = "updated" | "partial" | "failed";
