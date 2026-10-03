import type { CorporateAction, DistributionEvent, IntradayBar, MarketQuote } from "@kabutora/domain";
import type { MarketSessionStatus } from "./market-session";

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
  };
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
