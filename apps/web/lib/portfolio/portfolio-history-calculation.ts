import { calculateAverageCostPortfolio, canonicalDomainSecurityId, indexPortfolioHistoryBars, reconstructPortfolioHistorySteps, type CorporateAction, type DistributionEvent, type DividendReceipt, type LedgerTransaction, type MarketBar, type PortfolioHistoryPoint, type SecurityQuote, type PortfolioSummary } from "@kabutora/domain";
import { abortError } from "../ui/operation-deadline";
import { convertCalculationDataset, convertCalculationLedger } from "./portfolio-calculation-inputs";
import { securityMatchesPortfolioFilter } from "./portfolio-filter";
import { reconcilePortfolioParts } from "./portfolio-consistency";

export type HistoryDataset = {
  transactions: Array<LedgerTransaction & { tradeCurrency?: string }>;
  securities: Array<SecurityQuote & { currency?: string; country?: string; assetType?: string }>;
  bars: MarketBar[];
  corporateActions: CorporateAction[];
  distributions: DistributionEvent[];
  dividendReceipts?: DividendReceipt[];
  fx?: { current: number | null; previous: number | null };
};
export type HistorySelection = { transactionIds: string[]; throughDate: string; currency?: string; reconcile?: boolean };
export type PortfolioCalculationResult = { points: PortfolioHistoryPoint[]; summary: PortfolioSummary; nativeSummary: PortfolioSummary; reconciliation: ReturnType<typeof reconcilePortfolioParts>; renderBars: MarketBar[]; nativeRenderBars: MarketBar[]; filterSummaries?: Partial<Record<"ALL" | "JP" | "US" | "FUNDS_INDEXES", PortfolioSummary>> };
/** Holdings and totals, available before the slower history reconstruction finishes. */
export type PortfolioSummaryResult = Pick<PortfolioCalculationResult, "summary" | "nativeSummary" | "reconciliation" | "filterSummaries">;
export const emptyPortfolioCalculation: PortfolioCalculationResult = { points: [], summary: calculateAverageCostPortfolio([], []), nativeSummary: calculateAverageCostPortfolio([], []), reconciliation: { valid: true, differences: [] }, renderBars: [], nativeRenderBars: [], filterSummaries: { ALL: calculateAverageCostPortfolio([], []) } };
export function indexHistoryDataset(dataset: HistoryDataset): IndexedHistoryDataset {
  // The bar index serves only history reconstruction; summaries never wait for it.
  let bars: ReturnType<typeof indexPortfolioHistoryBars> | undefined;
  return {
    dataset,
    transactions: new Map(dataset.transactions.map((item) => [item.id, item])),
    get bars() { return bars ??= indexPortfolioHistoryBars(dataset.bars); },
    currencies: new Map<string, IndexedHistoryDataset>(),
  };
}
export type IndexedHistoryDataset = { dataset: HistoryDataset; transactions: Map<string, HistoryDataset["transactions"][number]>; bars: ReturnType<typeof indexPortfolioHistoryBars>; currencies: Map<string, IndexedHistoryDataset> };
type LedgerSource = Pick<IndexedHistoryDataset, "dataset" | "transactions">;

/** Accounting inputs converted per display currency, cached beside the dataset they came from. */
const ledgers = new WeakMap<IndexedHistoryDataset, Map<string, LedgerSource>>();
function convertedLedger(index: IndexedHistoryDataset, currency: string, throughDate: string): LedgerSource {
  const cache = ledgers.get(index) ?? new Map<string, LedgerSource>();
  ledgers.set(index, cache);
  const key = currency + ":" + throughDate;
  let ledger = cache.get(key);
  if (!ledger) {
    const dataset = convertCalculationLedger(index.dataset, currency, throughDate);
    ledger = { dataset, transactions: new Map(dataset.transactions.map((item) => [item.id, item])) };
    if (cache.size >= 2) cache.delete(cache.keys().next().value!);
    cache.set(key, ledger);
  }
  return ledger;
}

/**
 * Summary first (reported through `onSummary`), then the history reconstruction. Holdings and
 * totals therefore appear as soon as they are known, even while the chart is still being built.
 */
export async function calculatePortfolio(index: IndexedHistoryDataset, selection: HistorySelection, signal: AbortSignal, onSummary?: (summary: PortfolioSummaryResult) => void): Promise<PortfolioCalculationResult> {
  if (signal.aborted) throw abortError();
  const cacheKey = selection.currency ? selection.currency + ":" + selection.throughDate : "";
  let converted = cacheKey ? index.currencies.get(cacheKey) : index;
  const ledger: LedgerSource = converted ?? convertedLedger(index, selection.currency!, selection.throughDate);
  const selected = (source: LedgerSource) => selection.transactionIds.flatMap((id) => { const item = source.transactions.get(id); return item ? [item] : []; });
  const transactions = selected(ledger);
  const summarize = (source: LedgerSource, rows = selected(source)) => {
    const ids = new Set(rows.map((row) => `${row.accountId}:${canonicalDomainSecurityId(row.securityId ?? "")}`));
    const receipts = source.dataset.dividendReceipts?.filter((row) => ids.has(`${row.accountId}:${canonicalDomainSecurityId(row.securityId)}`));
    return calculateAverageCostPortfolio(rows, source.dataset.securities, source.dataset.corporateActions, source.dataset.distributions, selection.throughDate, receipts);
  };
  const summary = summarize(ledger, transactions);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (signal.aborted) throw abortError();
  const nativeSummary = summarize(index);
  let reconciliation = emptyPortfolioCalculation.reconciliation;
  const filterSummaries: Partial<Record<"ALL" | "JP" | "US" | "FUNDS_INDEXES", PortfolioSummary>> = {
    ALL: summary,
  };
  if (selection.reconcile) {
    const securities = new Map(index.dataset.securities.map((item) => [canonicalDomainSecurityId(item.id), item]));
    const parts: PortfolioSummary[] = [];
    for (const filter of ["JP", "US", "FUNDS_INDEXES"] as const) {
      const rows = transactions.filter((item) => securityMatchesPortfolioFilter(securities.get(canonicalDomainSecurityId(item.securityId ?? "")), filter, item.securityId ?? undefined));
      const partSummary = summarize(ledger, rows);
      parts.push(partSummary);
      filterSummaries[filter] = partSummary;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) throw abortError();
    }
    reconciliation = reconcilePortfolioParts(summary, parts);
  }
  onSummary?.({ summary, nativeSummary, reconciliation, filterSummaries });
  if (!converted) {
    converted = indexHistoryDataset(await convertCalculationDataset(index.dataset, selection.currency!, selection.throughDate, signal, ledger.dataset));
    if (index.currencies.size >= 2) index.currencies.delete(index.currencies.keys().next().value!);
    index.currencies.set(cacheKey, converted);
  }
  const points = await calculateHistory(converted, selection, signal);
  return { points, summary, nativeSummary, reconciliation, renderBars: sparklineBars(converted.dataset.bars), nativeRenderBars: sparklineBars(index.dataset.bars), filterSummaries };
}

function sparklineBars(bars: MarketBar[]) {
  const latest = new Map<string, string>();
  for (const bar of bars) if (bar.date > (latest.get(bar.securityId) ?? "")) latest.set(bar.securityId, bar.date);
  const starts = new Map([...latest].map(([id, date]) => [id, new Date(Date.parse(date) - 40 * 86400_000).toISOString().slice(0, 10)]));
  return bars.filter((bar) => bar.securityId !== "sec-fx-usdjpy" && bar.date >= starts.get(bar.securityId)!);
}

export async function calculateHistory(index: IndexedHistoryDataset, selection: HistorySelection, signal: AbortSignal): Promise<PortfolioHistoryPoint[]> {
  const transactions = selection.transactionIds.flatMap((id) => { const value = index.transactions.get(id); return value ? [value] : []; });
  const ids = new Set(transactions.flatMap((item) => item.securityId ? [`${item.accountId}:${canonicalDomainSecurityId(item.securityId)}`] : []));
  const { dataset } = index;
  const receipts = dataset.dividendReceipts?.filter((item) => ids.has(`${item.accountId}:${canonicalDomainSecurityId(item.securityId)}`));
  const steps = reconstructPortfolioHistorySteps(transactions, dataset.securities, dataset.bars, dataset.corporateActions, selection.throughDate, dataset.distributions, receipts, index.bars);
  let started = performance.now();
  for (;;) {
    if (signal.aborted) { steps.return([]); throw abortError(); }
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - started >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      started = performance.now();
    }
  }
}
