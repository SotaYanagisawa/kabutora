import { canonicalDomainSecurityId, type MarketBar, type MarketQuote } from "@kabutora/domain";
import { historicalFxRateAtDate } from "./historical-fx";
import { convertMoney } from "./money-conversion";
import { abortError } from "../ui/operation-deadline";
import type { HistoryDataset } from "./portfolio-history-calculation";

/** Prepare complete accounting inputs once per display currency and revision.
 * Filtering does not copy the source history or throw away accounting records. */
export async function convertCalculationDataset(dataset: HistoryDataset, currency: string, throughDate: string, signal: AbortSignal): Promise<HistoryDataset> {
  const securityMap = new Map(dataset.securities.map((item) => [canonicalDomainSecurityId(item.id), item]));
  const nativeCurrency = (id: string | null) => securityMap.get(canonicalDomainSecurityId(id ?? ""))?.currency ?? (id?.startsWith("sec-us-") ? "USD" : "JPY");
  const fx = dataset.bars.filter((bar) => bar.securityId === "sec-fx-usdjpy").sort((a, b) => a.date.localeCompare(b.date));
  const rateCache = new Map<string, number | null>();
  const rateAt = (date: string) => {
    const key = date.slice(0, 10);
    let rate = rateCache.get(key);
    if (rate === undefined) {
      rate = historicalFxRateAtDate(fx, key, dataset.fx?.current ?? null, true, throughDate);
      rateCache.set(key, rate);
    }
    return rate;
  };
  const transactions = dataset.transactions.flatMap((item) => {
    const from = item.tradeCurrency ?? nativeCurrency(item.securityId);
    const grossAmount = convertMoney(item.grossAmount, from, currency, rateAt(item.tradeDate));
    const pricePerShare = convertMoney(item.pricePerShare, from, currency, rateAt(item.tradeDate));
    // Preserve units even with unavailable FX. Null prices yield unpriced
    // holdings, while the UI marks the aggregate as unavailable.
    return [{ ...item, grossAmount, pricePerShare, tradeCurrency: currency }];
  });
  const securities = dataset.securities.map((item) => {
    const quote = item.quote;
    if (!quote) return { ...item, currency };
    const price = convertMoney(quote.price, item.currency ?? nativeCurrency(item.id), currency, dataset.fx?.current);
    if (price === null) return { ...item, currency, quote: undefined };
    const next: MarketQuote = { ...quote, price };
    for (const field of ["previousRegularClose", "dayOpen", "dayHigh", "dayLow"] as const) {
      const converted = convertMoney(quote[field], item.currency ?? nativeCurrency(item.id), currency, field === "previousRegularClose" ? dataset.fx?.previous : dataset.fx?.current);
      if (converted === null) delete next[field]; else next[field] = converted;
    }
    return { ...item, currency, quote: next };
  });
  const bars: MarketBar[] = [];
  let started = performance.now();
  for (const bar of dataset.bars) {
    if (signal.aborted) throw abortError();
    if (bar.securityId === "sec-fx-usdjpy") continue;
    const rate = rateAt(bar.date);
    const close = convertMoney(bar.close, nativeCurrency(bar.securityId), currency, rate);
    if (close !== null) {
      const adjustedClose = convertMoney(bar.adjustedClose, nativeCurrency(bar.securityId), currency, rate);
      bars.push({ ...bar, close, ...(adjustedClose === null ? {} : { adjustedClose }) });
    }
    if (performance.now() - started >= 8) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); started = performance.now(); }
  }
  const dividendReceipts = dataset.dividendReceipts?.flatMap((receipt) => {
    const amount = convertMoney(receipt.grossAmount, receipt.currency, currency, rateAt(receipt.recognitionDate));
    return amount === null ? [] : [{ ...receipt, currency, grossAmount: amount }];
  });
  return { ...dataset, transactions, securities, bars, dividendReceipts };
}
