/**
 * Market data shared by the market backend and the browser.
 *
 * Every record is keyed by `marketKey(securityId)`. Prices, splits and dividends for one security
 * always arrive together in one `DailyHistory` produced from one upstream response, so the split list
 * and the split-adjusted closes can never disagree.
 */

export type Session = "pre_market" | "regular" | "after_hours" | "pts_day" | "pts_night" | "closed";
export type Venue = "TSE" | "JNX" | "US" | "FUND" | "INDEX" | "FX" | "GLOBAL";

export type Quote = {
  key: string;
  price: number;
  /** Close of the session before the one `price` belongs to, in today's share units. */
  previousClose: number | null;
  /** Unix seconds of `price`. */
  time: number;
  session: Session;
  venue: Venue;
  currency: string;
  name?: string;
  longName?: string;
  exchange?: string;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
  /** Unix seconds when the backend read the upstream source. */
  fetchedAt: number;
};

/** Shares held before `date` (the ex-date) multiply by `ratio`. A 1:3 reverse split has ratio 1/3. */
export type Split = { date: string; ratio: number };

/** Cash per unit in today's share units (per `priceUnit` units for Japanese funds), native currency. */
export type Dividend = { date: string; amount: number; payDate?: string };

export type DailyHistory = {
  key: string;
  currency: string;
  /** Ascending YYYY-MM-DD trading dates. */
  dates: string[];
  /** Closes in today's share units (split-adjusted, not dividend-adjusted). */
  closes: number[];
  splits: Split[];
  dividends: Dividend[];
  /** Unix seconds. */
  fetchedAt: number;
};

export type IntradaySeries = {
  /** Ascending unix seconds. */
  times: number[];
  prices: number[];
};

export type Benchmark = {
  id: string;
  label: string;
  symbol: string;
  value: number;
  changeRatio: number | null;
  /** Unix seconds. */
  time: number;
};

export const FX_KEY = "sec-fx-usdjpy";

/**
 * The one canonical spelling of a listed security: `sec-7203`, `sec-285a`, `sec-us-aapl`,
 * `sec-jp-fund-02311886`. Ledger ids are never rewritten; lookups go through this function.
 */
export function marketKey(securityId: string): string {
  return securityId.toLowerCase().trim()
    .replace(/^sec-us-([a-z0-9.-]+)-(?:xnas|xnys|arcx|xase|bats|otcm|xams)$/u, "sec-us-$1")
    .replace(/^sec-([0-9]{4}|[0-9]{3}[a-z])-(?:xtks|tse)$/u, "sec-$1")
    .replace(/^(?:sec-)?([0-9]{4}|[0-9]{3}[a-z])(?:\.t)?$/u, "sec-$1");
}

/** Product of the ratios of splits strictly after `date`: converts shares held on `date` into today's shares. */
export function splitFactorAfter(splits: readonly Split[], date: string): number {
  let factor = 1;
  for (const split of splits) if (split.date > date) factor *= split.ratio;
  return factor;
}

/** Splits with a valid ratio, one per date, ascending. The last entry for a date wins. */
export function normalizeSplits(splits: readonly Split[]): Split[] {
  const byDate = new Map<string, number>();
  for (const split of splits) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(split.date) || !Number.isFinite(split.ratio) || split.ratio <= 0 || split.ratio === 1) continue;
    byDate.set(split.date, split.ratio);
  }
  return [...byDate].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([date, ratio]) => ({ date, ratio }));
}
