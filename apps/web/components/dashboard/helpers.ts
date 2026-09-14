import type {
  CorporateAction,
  DistributionEvent,
  IntradayBar,
  MarketQuote,
} from "@kabutora/domain";
import type { PortfolioNotification } from "../../lib/portfolio-notifications";
import type { MarketSessionStatus } from "../../lib/market-session";
import { calendarDateLabelJa } from "../../lib/calendar-time";
import { compactNumber } from "../../lib/compact-number";
import { marketDateTimeLabel } from "../../lib/chart-presentation";
import { mergePortfolioNotifications } from "../../lib/portfolio-notifications";
import { convertAmount, validUsdJpy } from "../../lib/money-conversion";
export { convertAmount, validUsdJpy };
import { Decimal } from "@kabutora/domain";
import { freshnessLabel, notificationTypes } from "./constants";
import type {
  CustomDateRange,
  DisplayCurrency,
  PackedIntradaySeries,
  RangeKey,
  Seed,
} from "./types";

export function resilientBrowserStorage(kind: "localStorage" | "sessionStorage" | "memory", prefix = ""): Storage {
  const backing = new Map<string, string>();
  const native = () => {
    try {
      return typeof window === "undefined" || kind === "memory" ? null : window[kind];
    } catch {
      return null;
    }
  };
  return {
    get length() {
      try {
        return native()?.length ?? backing.size;
      } catch {
        return backing.size;
      }
    },
    clear() {
      backing.clear();
      try {
        const storage = native();
        if (storage) for (const key of Object.keys(storage)) if (key.startsWith(prefix)) storage.removeItem(key);
      } catch {
        /* Memory fallback is already clear. */
      }
    },
    getItem(key) {
      try {
        return native()?.getItem(prefix + key) ?? backing.get(key) ?? null;
      } catch {
        return backing.get(key) ?? null;
      }
    },
    key(index) {
      try {
        return native()?.key(index) ?? [...backing.keys()][index] ?? null;
      } catch {
        return [...backing.keys()][index] ?? null;
      }
    },
    removeItem(key) {
      backing.delete(key);
      try {
        native()?.removeItem(prefix + key);
      } catch {
        /* Memory fallback remains usable. */
      }
    },
    setItem(key, value) {
      backing.set(key, value);
      try {
        native()?.setItem(prefix + key, value);
      } catch {
        /* Memory fallback remains usable. */
      }
    },
  };
}

export const safeLocalStorage = resilientBrowserStorage("localStorage");
export const safeSessionStorage = resilientBrowserStorage("sessionStorage");

export async function pooledClientMap<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>) {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        result[index] = await task(items[index]);
      }
    }),
  );
  return result;
}

export function filterDatedHistory<T extends { date: string }>(
  points: T[],
  range: RangeKey,
  customRange: CustomDateRange | null,
) {
  if (range === "CUSTOM" && customRange) {
    return points.filter((point) => point.date.slice(0, 10) >= customRange.from && point.date.slice(0, 10) <= customRange.to);
  }
  const latestDate = points.at(-1)?.date.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const cutoff = new Date(`${latestDate}T00:00:00Z`);
  if (range === "1W") cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  if (range === "1M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
  if (range === "3M") cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
  if (range === "YTD") cutoff.setUTCMonth(0, 1);
  return range === "ALL" ? points : points.filter((point) => new Date(`${point.date.slice(0, 10)}T00:00:00Z`) >= cutoff);
}

export const number = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 4 });
export const benchmarkNumber = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fxNumber = new Intl.NumberFormat("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 3 });

const moneyFormatters = new Map<string, Intl.NumberFormat>();
export const money = (value: number, currency = "JPY") => {
  const code = currency === "NATIVE" ? "JPY" : currency;
  const key = `${code}:${currency === "JPY" ? 0 : 2}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("ja-JP", { style: "currency", currency: code, maximumFractionDigits: currency === "JPY" ? 0 : 2 });
    if (moneyFormatters.size >= 32) moneyFormatters.delete(moneyFormatters.keys().next().value!);
    moneyFormatters.set(key, formatter);
  }
  return formatter.format(value);
};

export const signedMoney = (value: number, currency: string) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value), currency)}`;
export const maybeMoney = (value: string | number | null | undefined, currency: string) => (value == null ? "—" : money(Number(value), currency));
export const maybeSignedMoney = (value: string | number | null | undefined, currency: string) =>
  value == null ? "—" : signedMoney(Number(value), currency);
export const signedPercent = (value: number | null, digits = 2) => (value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`);

export const timeJa = (value: string, timeZone = "Asia/Tokyo") => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
};

export const dateJa = calendarDateLabelJa;

export const shortDateTimeJa = (value: string, timeZone = "Asia/Tokyo") => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${new Intl.DateTimeFormat("ja-JP", { timeZone, month: "numeric", day: "numeric" }).format(date)} ${timeJa(value, timeZone)}`;
};

export const costBasisGroupForAccount = (account: Seed["accounts"][number] | undefined, fallbackAccountId: string) =>
  account
    ? `${account.broker.trim().normalize("NFKC").toLocaleLowerCase("ja-JP")}\u0000${account.accountType.trim().normalize("NFKC").toLocaleLowerCase("ja-JP")}`
    : `account\u0000${fallbackAccountId}`;

export const isFundSecurity = (security: { id?: string; assetType?: string; exchangeMic?: string } | null | undefined, fallbackId?: string) =>
  security?.assetType === "fund" || security?.exchangeMic === "JPFD" || security?.exchangeMic === "XFND" || /^sec-(?:jp|us|foreign)-fund-/iu.test(security?.id ?? fallbackId ?? "");

export const isIndexSecurity = (security: { id?: string; assetType?: string; exchangeMic?: string } | null | undefined, fallbackId?: string) =>
  security?.assetType === "index" || security?.exchangeMic === "XIND" || /^sec-us-index-/iu.test(security?.id ?? fallbackId ?? "");

export const securityPriceUnit = (security: { priceUnit?: string } | null | undefined) => {
  const unit = Number(security?.priceUnit ?? 1);
  return Number.isFinite(unit) && unit > 0 ? unit : 1;
};

export const securityQuantityUnit = (security: { id?: string; assetType?: string; exchangeMic?: string } | null | undefined, fallbackId?: string) =>
  isFundSecurity(security, fallbackId) ? "口" : isIndexSecurity(security, fallbackId) ? "単位" : "株";

export const securityPriceBasis = (security: { id?: string; assetType?: string; exchangeMic?: string; priceUnit?: string } | null | undefined, fallbackId?: string) =>
  isFundSecurity(security, fallbackId) ? (securityPriceUnit(security) === 10_000 ? "1万口" : "1口") : "";


export const shortMoney = (value: number, currency: DisplayCurrency | string) => {
  const effective = currency === "NATIVE" ? "JPY" : currency;
  if (effective === "JPY" && Math.abs(value) >= 100_000_000) return `¥${(value / 100_000_000).toFixed(2)}億`;
  if (effective === "JPY" && Math.abs(value) >= 10_000) return `¥${compactNumber(value / 10_000)}万`;
  if (effective === "USD" && Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (effective === "USD" && Math.abs(value) >= 1_000) return `$${compactNumber(value / 1_000)}K`;
  return money(value, effective);
};

export const compactMoney = (value: number, currency: DisplayCurrency | string, signed = false) => {
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  const absolute = Math.abs(value);
  const effective = currency === "NATIVE" ? "JPY" : currency;
  if (effective === "JPY" && absolute >= 10_000) return `${sign}¥${compactNumber(absolute / 10_000)}万`;
  if (effective === "USD" && absolute >= 1_000) return `${sign}$${compactNumber(absolute / 1_000)}K`;
  return `${sign}${money(absolute, effective)}`;
};

export const formatDayGainMoney = (value: number, currency: DisplayCurrency | string) => {
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  const absolute = Math.abs(value);
  const effective = currency === "NATIVE" ? "JPY" : currency;
  if (effective === "JPY") {
    if (absolute >= 100_000_000) return `${sign}¥${(absolute / 100_000_000).toFixed(2)}億`;
    if (absolute >= 1_000_000) return `${sign}¥${compactNumber(absolute / 10_000)}万`;
    return `${sign}¥${number.format(Math.round(absolute))}`;
  }
  if (effective === "USD") {
    if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
    if (absolute >= 10_000) return `${sign}$${compactNumber(absolute / 1_000)}K`;
    return `${sign}${money(absolute, effective)}`;
  }
  return `${sign}${money(absolute, effective)}`;
};


export const csvEscape = (value: unknown) => {
  const raw = value == null ? "" : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};

export const download = (name: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
};

export function packIntradayBars(bars: IntradayBar[]): PackedIntradaySeries {
  const series: PackedIntradaySeries = {};
  for (const bar of bars) {
    const current = series[bar.securityId] ?? { provider: bar.provider, rows: [] };
    current.provider = bar.provider || current.provider;
    current.rows.push([bar.timestamp, bar.price, bar.venueCode, bar.session]);
    series[bar.securityId] = current;
  }
  return series;
}

export function unpackIntradayBars(series: PackedIntradaySeries | null | undefined) {
  if (!series) return [];
  return Object.entries(series).flatMap(([securityId, value]) =>
    value.rows.map(([timestamp, price, venueCode, session]) => ({
      securityId,
      timestamp,
      price,
      provider: value.provider,
      ...(venueCode ? { venueCode } : {}),
      ...(session ? { session } : {}),
    })),
  );
}

export function readStoredIds(storage: Storage, key: string) {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200))];
  } catch {
    storage.removeItem(key);
    return [];
  }
}

export function readStoredNotifications(storage: Storage) {
  const key = "kabutora-notification-history-v1";
  try {
    const value = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return mergePortfolioNotifications(
      value.filter((item): item is PortfolioNotification => {
        if (!item || typeof item !== "object") return false;
        const notice = item as Partial<PortfolioNotification>;
        return (
          typeof notice.id === "string" &&
          notice.id.length > 0 &&
          notice.id.length <= 300 &&
          typeof notice.securityId === "string" &&
          notice.securityId.length > 0 &&
          notice.securityId.length <= 300 &&
          typeof notice.type === "string" &&
          notificationTypes.has(notice.type as PortfolioNotification["type"]) &&
          typeof notice.occurredAt === "string" &&
          Number.isFinite(Date.parse(notice.occurredAt)) &&
          typeof notice.title === "string" &&
          typeof notice.summary === "string" &&
          typeof notice.source === "string"
        );
      }),
    );
  } catch {
    storage.removeItem(key);
    return [];
  }
}

export function mergeActions(...groups: CorporateAction[][]) {
  return [...new Map(groups.flat().map((action) => [action.id, action])).values()].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
}

export function mergeDistributionEvents(...groups: DistributionEvent[][]) {
  const confidenceRank: Record<DistributionEvent["confidence"], number> = { estimated: 1, reported: 2, official: 3, manual: 4 };
  const merged = new Map<string, DistributionEvent>();
  for (const event of groups.flat()) {
    const current = merged.get(event.id);
    if (!current || confidenceRank[event.confidence] >= confidenceRank[current.confidence]) merged.set(event.id, event);
  }
  return [...merged.values()].sort((left, right) => {
    const leftDate = left.paymentDate ?? left.exDate ?? left.recordDate ?? "";
    const rightDate = right.paymentDate ?? right.exDate ?? right.recordDate ?? "";
    return leftDate === rightDate ? left.id.localeCompare(right.id) : leftDate.localeCompare(rightDate);
  });
}

export function latestMarketSessions(responses: Array<{ payload: { marketSessions?: MarketSessionStatus[] } }>) {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const sessions = responses[index].payload.marketSessions;
    if (sessions?.length) return sessions;
  }
  return null;
}

export function quoteTradeSourceLabel(quote: MarketQuote) {
  return quote.venueCode === "FUND"
    ? "基準価額"
    : quote.venueCode === "INDEX"
    ? "指数値"
    : quote.venueCode === "JNX"
    ? "PTS約定"
    : quote.venueCode === "TSE" && quote.priceType === "official_close"
    ? "東証終値"
    : "最終約定";
}

export function quoteTimestampLabel(quote: MarketQuote & { exchangeMic?: string }, timeZone?: string) {
  return `取得 ${shortDateTimeJa(quote.fetchedAt)}（端末） · ${quoteTradeSourceLabel(quote)} ${marketDateTimeLabel(quote.marketTimestamp, quote.exchangeMic, timeZone)}（市場現地） · ${freshnessLabel[quote.freshness]}`;
}

export function tickerQuoteTimestampLabel(quote: MarketQuote & { exchangeMic?: string }, timeZone?: string) {
  const freshness = quote.freshness === "near_live" ? "" : ` · ${freshnessLabel[quote.freshness]}`;
  return `取得 ${shortDateTimeJa(quote.fetchedAt)}（端末） · ${quoteTradeSourceLabel(quote)} ${marketDateTimeLabel(quote.marketTimestamp, quote.exchangeMic, timeZone)}（市場現地）${freshness}`;
}
