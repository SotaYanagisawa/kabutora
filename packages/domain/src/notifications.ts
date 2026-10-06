import { addDays, dateInZone } from "./dates";
import { marketKey, splitFactorAfter } from "./market";
import { priceUnitOf, previousCloseFor, quoteSessionDate, type Book, type LedgerTransaction } from "./portfolio";

/** Persisted in preferences, so number-like fields stay strings for compatibility with stored history. */
export type PortfolioNotification = {
  id: string;
  securityId: string;
  type: "SPLIT" | "REVERSE_SPLIT" | "LIMIT_UP" | "LIMIT_DOWN" | "PRICE_UP" | "PRICE_DOWN" | "TOB" | "CORPORATE";
  occurredAt: string;
  title: string;
  summary: string;
  source: string;
  currency?: string;
  beforeQuantity?: string;
  afterQuantity?: string;
  beforeAverageCost?: string;
  afterAverageCost?: string;
  beforeReferencePrice?: string;
  afterReferencePrice?: string;
  limitPrice?: string;
  changeRatio?: string;
  portfolioImpact?: "ADJUSTED" | "INFORMATIONAL";
  offerPrice?: string;
  expiresAt?: string;
  url?: string;
};

export const DEFAULT_PRICE_ALERT_PERCENT = 5;
export const PRICE_ALERT_THRESHOLDS = [3, 4, 5, 6, 7, 8, 10, 15, 20] as const;

const LIMIT_BANDS: Array<[upperExclusive: number, width: number]> = [
  [100, 30], [200, 50], [500, 80], [700, 100], [1_000, 150], [1_500, 300], [2_000, 400], [3_000, 500],
  [5_000, 700], [7_000, 1_000], [10_000, 1_500], [15_000, 3_000], [20_000, 4_000], [30_000, 5_000],
  [50_000, 7_000], [70_000, 10_000], [100_000, 15_000], [150_000, 30_000], [200_000, 40_000],
  [300_000, 50_000], [500_000, 70_000], [700_000, 100_000], [1_000_000, 150_000], [1_500_000, 300_000],
  [2_000_000, 400_000], [3_000_000, 500_000], [5_000_000, 700_000], [7_000_000, 1_000_000],
  [10_000_000, 1_500_000], [15_000_000, 3_000_000], [20_000_000, 4_000_000], [30_000_000, 5_000_000],
  [50_000_000, 7_000_000], [Number.POSITIVE_INFINITY, 10_000_000],
];

/** TSE daily price-limit width for a base price. */
export function tseDailyPriceLimit(previousClose: number) {
  return LIMIT_BANDS.find(([upper]) => previousClose < upper)?.[1] ?? 10_000_000;
}

export type NoticeSecurity = { id: string; name: string; currency?: string; exchangeMic?: string; priceUnit?: string | number };

const tradable = (security: NoticeSecurity) => !security.exchangeMic || ["XTKS", "XNAS", "XNYS", "ARCX", "XASE", "BATS", "OTCM"].includes(security.exchangeMic);
const isTse = (security: NoticeSecurity, key: string) => security.exchangeMic === "XTKS" || /^sec-(?:[0-9]{4}|[0-9]{3}[a-z])$/u.test(key);
const noticeId = (securityId: string, type: PortfolioNotification["type"], date: string) => `notice:${securityId}:${type.toLowerCase().replaceAll("_", "-")}:${date}`;

function priceMove(security: NoticeSecurity, key: string, date: string, occurredAt: string, previous: number, current: number, threshold: number, source: string): PortfolioNotification | null {
  if (!(previous > 0) || !(current > 0)) return null;
  const currency = security.currency ?? (isTse(security, key) ? "JPY" : "USD");
  if (isTse(security, key)) {
    const width = tseDailyPriceLimit(previous);
    const tolerance = Math.max(0.01, current * 0.00001);
    const up = current >= previous + width - tolerance;
    const down = current <= Math.max(0, previous - width) + tolerance;
    if (up || down) {
      const type = up ? "LIMIT_UP" : "LIMIT_DOWN";
      return {
        id: noticeId(security.id, type, date), securityId: security.id, type, occurredAt,
        title: `${security.name}が${up ? "ストップ高" : "ストップ安"}`,
        summary: `前日終値から値幅制限${up ? "上限" : "下限"}に到達`,
        source, currency, limitPrice: String(up ? previous + width : Math.max(0, previous - width)),
      };
    }
  }
  const change = current / previous - 1;
  if (Math.abs(change) < threshold) return null;
  const type = change > 0 ? "PRICE_UP" : "PRICE_DOWN";
  return {
    id: noticeId(security.id, type, date), securityId: security.id, type, occurredAt,
    title: `${security.name}が${change > 0 ? "急騰" : "急落"}`,
    summary: `前日終値から${Math.abs(change * 100).toFixed(1)}%${change > 0 ? "上昇" : "下落"}`,
    source, currency, changeRatio: String(change),
  };
}

/**
 * Notices derived from market data: splits applied to holdings, daily price moves since the first
 * trade (or for watched securities), and the current session's move.
 */
export function derivePortfolioNotifications<T extends LedgerTransaction>(input: {
  book: Book<T>;
  securities: ReadonlyMap<string, NoticeSecurity>;
  watchedIds?: ReadonlySet<string>;
  /** Fraction, e.g. 0.05. */
  threshold: number;
}): PortfolioNotification[] {
  const { book, securities, threshold } = input;
  const notices: PortfolioNotification[] = [];
  const ids = new Set<string>([...book.bySecurity.keys(), ...(input.watchedIds ?? [])]);
  for (const securityId of ids) {
    const security = securities.get(securityId);
    if (!security || !tradable(security)) continue;
    const key = marketKey(securityId);
    const history = book.market.history.get(key);
    const trades = book.bySecurity.get(securityId) ?? [];
    const firstTrade = trades[0]?.date;
    const unit = priceUnitOf(security);

    for (const split of history?.splits ?? []) {
      if (!firstTrade || split.date <= firstTrade) continue;
      let quantity = 0;
      let cost = 0;
      for (const trade of trades) {
        if (trade.date >= split.date) break;
        if (trade.side > 0) {
          quantity += trade.quantity;
          cost += trade.amount;
        } else if (quantity > 0) {
          const sold = Math.min(quantity, trade.quantity);
          cost -= cost * (sold / quantity);
          quantity -= sold;
        }
      }
      if (quantity <= 1e-9) continue;
      // Today's units → units on the day before the split.
      const before = quantity / splitFactorAfter(history!.splits, addDays(split.date, -1));
      const reverse = split.ratio < 1;
      const index = history!.dates.findIndex((date) => date >= split.date);
      const priceBefore = index > 0 ? history!.closes[index - 1] * splitFactorAfter(history!.splits, history!.dates[index - 1]) : null;
      const priceAfter = index >= 0 ? history!.closes[index] * splitFactorAfter(history!.splits, history!.dates[index]) : null;
      const ratioLabel = reverse ? `${Math.round(1 / split.ratio)}株→1株` : `1株→${split.ratio}株`;
      notices.push({
        id: `notice:${securityId}:split:${split.date}`,
        securityId,
        type: reverse ? "REVERSE_SPLIT" : "SPLIT",
        occurredAt: split.date,
        title: `${security.name}の${reverse ? "株式併合" : "株式分割"}`,
        summary: `${ratioLabel}（保有数・平均取得単価に自動反映）`,
        source: "yahoo",
        currency: security.currency ?? "JPY",
        portfolioImpact: "ADJUSTED",
        beforeQuantity: String(before),
        afterQuantity: String(before * split.ratio),
        beforeAverageCost: String((cost / before) * unit),
        afterAverageCost: String((cost / (before * split.ratio)) * unit),
        ...(priceBefore ? { beforeReferencePrice: String(priceBefore) } : {}),
        ...(priceAfter ? { afterReferencePrice: String(priceAfter) } : {}),
      });
    }

    const since = firstTrade ?? (input.watchedIds?.has(securityId) ? addDays(new Date().toISOString().slice(0, 10), -90) : null);
    if (history && since) {
      for (let index = 1; index < history.dates.length; index += 1) {
        const date = history.dates[index];
        if (date < since) continue;
        const notice = priceMove(security, key, date, date, history.closes[index - 1], history.closes[index], threshold, "yahoo");
        if (notice) notices.push(notice);
      }
    }

    const quote = book.market.quotes.get(key);
    if (quote) {
      const sessionDate = quoteSessionDate(quote);
      const previous = previousCloseFor(quote, history, sessionDate);
      const occurredAt = new Date(quote.time * 1000).toISOString();
      const notice = previous ? priceMove(security, key, sessionDate, occurredAt, previous, quote.price, threshold, quote.venue) : null;
      if (notice && dateInZone(quote.time * 1000, "Asia/Tokyo") >= sessionDate) notices.push(notice);
    }
  }
  return mergePortfolioNotifications(notices);
}

/** Later groups win on equal ids; newest first. Stored split notices are dropped: they are always re-derived. */
export function mergePortfolioNotifications(...groups: PortfolioNotification[][]) {
  const merged = new Map<string, PortfolioNotification>();
  groups.forEach((group, index) => {
    for (const notice of group) {
      if (index < groups.length - 1 && (notice.type === "SPLIT" || notice.type === "REVERSE_SPLIT")) continue;
      merged.set(notice.id, notice);
    }
  });
  return [...merged.values()].sort((left, right) => (left.occurredAt < right.occurredAt ? 1 : left.occurredAt > right.occurredAt ? -1 : left.id.localeCompare(right.id)));
}
