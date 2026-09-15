import type { MarketStatus } from "@/components/dashboard/types";

export type UpdatingPhase = "updating" | "done" | "error";

export interface UpdatingStatusOptions {
  isManualRefreshing: boolean;
  quoteStatus: MarketStatus;
  historyStatus: MarketStatus;
  distributionStatus: MarketStatus;
  benchmarkStatus: MarketStatus;
}

export function isActivelyUpdating(options: UpdatingStatusOptions): boolean {
  return (
    options.isManualRefreshing ||
    options.historyStatus === "loading" ||
    options.quoteStatus === "loading" ||
    options.distributionStatus === "loading" ||
    options.benchmarkStatus === "loading"
  );
}

export function resolveUpdatingMessage(options: UpdatingStatusOptions): string {
  const isHistory = options.historyStatus === "loading";
  const isQuote = options.quoteStatus === "loading" || options.isManualRefreshing;
  const isDist = options.distributionStatus === "loading";
  const isBenchmark = options.benchmarkStatus === "loading";

  if (isHistory && isQuote) return "市場データと履歴を更新中…";
  if (isHistory) return "履歴データを取得中…";
  if (isQuote) return "株価データを更新中…";
  if (isDist) return "配当データを更新中…";
  if (isBenchmark) return "為替・指標を取得中…";
  return "データを更新中…";
}
