import type { CorporateAction, DistributionEvent, IntradayBar, MarketBar, MarketQuote } from "@kabutora/domain";
import type { MarketSessionStatus } from "./market-session";

export type PublicSecurityDescriptor = {
  securityId: string;
  displaySymbol: string;
  providerSymbol: string;
  exchangeMic: string;
  currency: string;
  venueCode: "TSE" | "US" | "FX" | "FUND" | "USD_FUND" | "INDEX" | "GLOBAL";
  assetType: "stock" | "fund" | "index" | "fx" | "global";
};

export type ServerRemoteQuote = MarketQuote & {
  securityId: string;
  symbol: string;
  exchangeMic: string;
  exchangeLabel?: string;
  currency: string;
  brandName?: string;
  brandNameSource?: string;
  shortName?: string;
  longName?: string;
};

export type ServerBenchmark = {
  id: string;
  label: string;
  symbol: string;
  value: number;
  changeRatio: number | null;
  marketTimestamp: string;
  freshness: MarketQuote["freshness"];
  fetchedAt?: string;
};

export type ServerMarketSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  savedAt: string | null;
  marketSessions: MarketSessionStatus[];
  quotes: ServerRemoteQuote[];
  benchmarks: ServerBenchmark[];
  intraday: IntradayBar[];
  /** Changes whenever the persisted intraday series changes, independently of quotes. */
  intradayRevision?: string | null;
  coverage: {
    registered: number;
    quoted: number;
    fresh: number;
    stale: number;
    suspect: number;
  };
  refresh: {
    status: "ready" | "partial" | "empty";
    lastRunAt: string | null;
    queueMessagesToday: number;
    providerCallsToday: number;
  };
};

export type ServerHistorySnapshot = {
  generatedAt: string;
  bars: MarketBar[];
  corporateActions: CorporateAction[];
  distributions: DistributionEvent[];
  inceptionDates: Record<string, string>;
  securityIds: string[];
};

export type DistributionCoverageStatus = "ready" | "no_events" | "partial" | "error";

export type DistributionCoverage = {
  securityId: string;
  coveredFrom: string;
  checkedThrough: string;
  checkedAt: string;
  eventCount: number;
  status: DistributionCoverageStatus;
  sourceProvider?: string;
};

export type MarketDistributionBatchResult = {
  generatedAt: string;
  distributions: DistributionEvent[];
  corporateActions: CorporateAction[];
  coverage: DistributionCoverage[];
  failures: Array<{ securityId: string; symbol: string; message: string }>;
};

export type MarketRefreshJob = {
  version: 1;
  claimId: string;
  runId: string;
  kind: "quotes" | "history" | "distributions" | "benchmarks";
  securityIds: string[];
  scheduledAt: string;
};

export type MarketQuoteBatchResult = {
  generatedAt: string;
  marketSessions: MarketSessionStatus[];
  quotes: ServerRemoteQuote[];
  intraday: IntradayBar[];
  failures: Array<{ securityId: string; symbol: string; message: string }>;
  coverage: { requested: number; returned: number; fresh: number; stale: number; suspect: number };
};

export type MarketHistoryBatchResult = {
  generatedAt: string;
  requestedFrom: string;
  marketSessions: MarketSessionStatus[];
  bars: MarketBar[];
  corporateActions: CorporateAction[];
  distributions: DistributionEvent[];
  inceptionDates: Record<string, string>;
  failures: Array<{ securityId: string; symbol: string; message: string }>;
  coverage: { requested: number; returned: number };
  coveredSecurityIds: string[];
  quality: { checksum: string; status: string; [key: string]: unknown };
};
