import { mergePortfolioNotifications, type PortfolioNotification } from "@kabutora/domain/notifications";
import { calendarDateLabelJa } from "../../lib/ui/calendar-time";
import { compactNumber } from "../../lib/ui/compact-number";
import { exchangeTimeZone, exchangeTimeZoneCode } from "../../lib/charts/market-time";
import { notificationTypes } from "./constants";
import type { CustomDateRange, DisplayCurrency, DisplayQuote, RangeKey, Seed } from "./types";

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
  if (effective === "JPY") {
    if (absolute >= 100_000_000) return `${sign}¥${compactNumber(absolute / 100_000_000)}億`;
    if (absolute >= 10_000) return `${sign}¥${compactNumber(absolute / 10_000)}万`;
  }
  if (effective === "USD") {
    if (absolute >= 1_000_000) return `${sign}$${compactNumber(absolute / 1_000_000)}M`;
    if (absolute >= 1_000) return `${sign}$${compactNumber(absolute / 1_000)}K`;
  }
  return `${sign}${money(absolute, effective)}`;
};

export const compactPrice = (
  value: number | string | null | undefined,
  currency: DisplayCurrency | string,
) => {
  if (value == null) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  const effective = currency === "NATIVE" ? "JPY" : currency;
  const absolute = Math.abs(num);
  if (effective === "JPY") {
    if (absolute >= 100_000_000) return `¥${compactNumber(absolute / 100_000_000)}億`;
    if (absolute >= 100_000) return `¥${compactNumber(absolute / 10_000)}万`;
    return `¥${Math.round(num).toLocaleString("en-US")}`;
  }
  if (effective === "USD") {
    if (absolute >= 1_000_000) return `$${compactNumber(absolute / 1_000_000)}M`;
    if (absolute >= 10_000) return `$${compactNumber(absolute / 1_000)}K`;
    if (absolute >= 1_000) return `$${Math.round(num).toLocaleString("en-US")}`;
    return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return maybeMoney(value, currency);
};

export const formatWidgetFetchedTime = (
  fetchedAt?: string | null,
  marketTimestamp?: string | null,
  stockMic?: string,
  stockTz?: string,
  stockCurrency?: string,
  stockCountry?: string,
  currentTime?: number | Date | null,
) => {
  const ts = marketTimestamp || fetchedAt;
  if (!ts) return null;
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;

  const tz = exchangeTimeZone(stockMic, stockTz, stockCurrency, stockCountry);
  const tzCode = exchangeTimeZoneCode(d, tz);

  const now = currentTime ? new Date(currentTime) : new Date();
  const sameDay =
    d.toLocaleDateString("en-CA", { timeZone: tz }) ===
    now.toLocaleDateString("en-CA", { timeZone: tz });

  const timeStr = new Intl.DateTimeFormat("ja-JP", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);

  if (sameDay) {
    return `${timeStr} ${tzCode}`;
  }

  const dateStr = new Intl.DateTimeFormat("ja-JP", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
  }).format(d);

  return `${dateStr} ${timeStr} ${tzCode}`;
};

type QuoteTimeFormats = { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat; monthDay: Intl.DateTimeFormat };
const quoteTimeFormats = new Map<string, QuoteTimeFormats>();
const quoteTimeFormatsFor = (timeZone: string) => {
  let formats = quoteTimeFormats.get(timeZone);
  if (!formats) {
    formats = {
      day: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }),
      time: new Intl.DateTimeFormat("ja-JP", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
      monthDay: new Intl.DateTimeFormat("ja-JP", { timeZone, month: "numeric", day: "numeric" }),
    };
    quoteTimeFormats.set(timeZone, formats);
  }
  return formats;
};

/**
 * Card-sized quote time in the exchange's time zone: "15:30" on the exchange's current day, otherwise
 * the date alone ("10/6"). The full date, time and zone belong in the card's title.
 */
export function compactQuoteTime(timestamp: string | null | undefined, timeZone: string, now: number | Date = Date.now()) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const formats = quoteTimeFormatsFor(timeZone);
  return formats.day.format(date) === formats.day.format(now) ? formats.time.format(date) : formats.monthDay.format(date);
}

/** Short session label for a quote card. */
export function quoteSessionLabel(quote: Pick<DisplayQuote, "venueCode" | "session">) {
  if (quote.venueCode === "FUND") return "基準価額";
  if (quote.venueCode === "INDEX") return "指数";
  if (quote.venueCode === "JNX" || quote.session === "pts_day" || quote.session === "pts_night") return "PTS";
  if (quote.session === "pre_market") return "プレ";
  if (quote.session === "after_hours") return "時間外";
  return quote.session === "regular" ? "取引中" : "終値";
}

/** "+12.3%", or "+929%" / "+1,157%" from 100%: no decimals once three digits would crowd a card. */
export const compactSignedPercent = (value: number | null, digits = 1) =>
  value == null ? "—" : Math.abs(value) >= 1 ? `${value >= 0 ? "+" : "-"}${number.format(Math.round(Math.abs(value) * 100))}%` : signedPercent(value, digits);

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

export function quoteTradeSourceLabel(quote: Pick<DisplayQuote, "venueCode" | "priceType" | "session">) {
  return quote.venueCode === "FUND"
    ? "基準価額"
    : quote.venueCode === "INDEX"
    ? "指数値"
    : quote.venueCode === "JNX"
    ? "PTS約定"
    : quote.venueCode === "TSE" && quote.priceType === "official_close"
    ? "東証終値"
    : quote.session === "pre_market"
    ? "プレ約定"
    : quote.session === "after_hours"
    ? "時間外約定"
    : quote.priceType === "official_close"
    ? "終値"
    : "最終約定";
}