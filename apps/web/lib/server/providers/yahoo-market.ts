import type { CorporateAction, DistributionEvent, MarketBar } from "@kabutora/domain";

type YahooChartResult = {
  meta?: { currency?: string; firstTradeDate?: number };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>;
    adjclose?: Array<{ adjclose?: Array<number | null> }>;
  };
  events?: {
    splits?: Record<string, { date?: number; numerator?: number; denominator?: number }>;
    dividends?: Record<string, { amount?: number; date?: number }>;
    capitalGains?: Record<string, { amount?: number; date?: number }>;
  };
};

type YahooPayload = {
  chart?: { result?: YahooChartResult[] | null; error?: { description?: string } | null };
};

const hosts = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
const USER_AGENT = "Mozilla/5.0 (compatible; Kabutora/3.0)";

export class MarketDataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MarketDataError";
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ymdInTokyo(value: number) {
  // Japan has no daylight-saving transitions; one Date per bar keeps CPU low.
  return new Date((value + 9 * 60 * 60) * 1000).toISOString().slice(0, 10);
}

function chartUrl(host: string, symbol: string, params: Record<string, string>) {
  return `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams({ ...params, includePrePost: "true" })}`;
}

async function fetchChart(symbol: string, params: Record<string, string>) {
  if (!/^[A-Za-z0-9.^=_-]{1,32}$/u.test(symbol)) throw new MarketDataError("Invalid market symbol");
  const failures: string[] = [];
  for (const host of hosts) {
    try {
      const response = await fetch(chartUrl(host, symbol, params), {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new MarketDataError(`${host} returned HTTP ${response.status}`, response.status);
      const payload = (await response.json()) as YahooPayload;
      const result = payload.chart?.result?.[0];
      if (!result) throw new MarketDataError(`${host}: ${payload.chart?.error?.description ?? "empty chart response"}`);
      return { value: result, host };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new MarketDataError(failures.join("; "));
}

/** Converts a Yahoo Japan board update time (H:mm or M/D) to an ISO timestamp. */
export function tokyoMarketTimestamp(updateTime: string | undefined, now = new Date()) {
  const clean = updateTime?.trim();
  if (!clean) return now.toISOString();
  const tokyoParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => tokyoParts.find((item) => item.type === type)?.value ?? "";
  const currentYear = Number(part("year"));
  const currentMonth = Number(part("month"));
  const currentDay = Number(part("day"));
  const weekday = part("weekday");
  const currentMinute = Number(part("hour")) * 60 + Number(part("minute"));

  const dateMatch = /^(?:(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2}))(?:\s+(\d{1,2}):(\d{2}))?$/u.exec(clean);
  if (dateMatch) {
    const rawMonth = Number(dateMatch[2]);
    const rawDay = Number(dateMatch[3]);
    let year = dateMatch[1] ? Number(dateMatch[1]) : currentYear;
    if (!dateMatch[1]) {
      if (currentMonth === 1 && rawMonth === 12) year -= 1;
      else if (currentMonth === 12 && rawMonth === 1) year += 1;
    }
    // Without a time, use the TSE close (15:30 JST).
    const hour = dateMatch[4] != null ? Number(dateMatch[4]) : 15;
    const minute = dateMatch[5] != null ? Number(dateMatch[5]) : 30;
    const date = new Date(Date.UTC(year, rawMonth - 1, rawDay, hour - 9, minute));
    return Number.isFinite(date.getTime()) ? date.toISOString() : now.toISOString();
  }

  const timeMatch = /^(\d{1,2}):(\d{2})$/u.exec(clean);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    let daysToSubtract = 0;
    if (weekday === "Sat") daysToSubtract = 1;
    else if (weekday === "Sun") daysToSubtract = 2;
    else if (currentMinute < hour * 60 + minute) daysToSubtract = weekday === "Mon" ? 3 : 1;
    const date = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay, hour - 9, minute));
    if (daysToSubtract > 0) date.setUTCDate(date.getUTCDate() - daysToSubtract);
    return Number.isFinite(date.getTime()) ? date.toISOString() : now.toISOString();
  }
  return now.toISOString();
}

export async function getYahooHistory(
  symbol: string,
  securityId: string,
  period1: number,
  period2: number,
  _force = false,
  distributionsOnly = false,
) {
  const fiveYearsAgo = Math.floor((Date.now() - 5 * 365 * 24 * 60 * 60 * 1000) / 1000);
  const fetchPeriod1 = Math.min(period1, fiveYearsAgo);
  const params = { interval: distributionsOnly ? "1mo" : "1d", period1: String(fetchPeriod1), period2: String(period2), events: "capitalGain|div|split", includeAdjustedClose: distributionsOnly ? "false" : "true" };
  const { value: result, host } = await fetchChart(symbol, params);
  const provider = `yahoo_chart_unofficial:${host}`;
  const firstTradeTimestamp = finiteNumber(result.meta?.firstTradeDate);
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const adjustedCloses = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: MarketBar[] = [];
  for (let index = 0; !distributionsOnly && index < Math.min(timestamps.length, closes.length); index += 1) {
    const timestamp = finiteNumber(timestamps[index]);
    const close = finiteNumber(closes[index]);
    if (timestamp == null || close == null || close <= 0) continue;
    const adjustedClose = finiteNumber(adjustedCloses[index]);
    bars.push({
      securityId,
      date: ymdInTokyo(timestamp),
      close: String(close),
      ...(adjustedClose != null && adjustedClose > 0 ? { adjustedClose: String(adjustedClose) } : {}),
      provider,
    });
  }

  const corporateActions: CorporateAction[] = [];
  for (const [eventKey, split] of Object.entries(result.events?.splits ?? {})) {
    const timestamp = finiteNumber(split.date) ?? finiteNumber(Number(eventKey));
    const numerator = finiteNumber(split.numerator);
    const denominator = finiteNumber(split.denominator);
    if (timestamp == null || numerator == null || denominator == null || numerator <= 0 || denominator <= 0) continue;
    corporateActions.push({
      id: `${securityId}-split-${timestamp}`,
      securityId,
      type: numerator >= denominator ? "SPLIT" : "REVERSE_SPLIT",
      effectiveDate: ymdInTokyo(timestamp),
      numerator: String(numerator),
      denominator: String(denominator),
      sourceProvider: provider,
    });
  }
  const distributions: DistributionEvent[] = [];
  const currency = result.meta?.currency ?? (symbol.endsWith(".T") ? "JPY" : "USD");
  const sourceUrl = chartUrl(host, symbol, { ...params, includeAdjustedClose: "false" });
  const appendDistributions = (source: Record<string, { amount?: number; date?: number }> | undefined, type: DistributionEvent["type"]) => {
    for (const [eventKey, item] of Object.entries(source ?? {})) {
      const timestamp = finiteNumber(item.date) ?? finiteNumber(Number(eventKey));
      const amount = finiteNumber(item.amount);
      if (timestamp == null || amount == null || amount < 0) continue;
      distributions.push({
        id: `${securityId}-${type.toLowerCase()}-${timestamp}`,
        securityId,
        type,
        exDate: ymdInTokyo(timestamp),
        amountPerUnit: String(amount),
        distributionUnit: "1",
        currency,
        sourceProvider: provider,
        sourceUrl,
        confidence: "reported",
        status: "estimated",
        fetchedAt: new Date().toISOString(),
      });
    }
  };
  appendDistributions(result.events?.dividends, "CASH_DIVIDEND");
  appendDistributions(result.events?.capitalGains, "CAPITAL_GAIN_DISTRIBUTION");
  return {
    bars,
    corporateActions,
    distributions,
    ...(firstTradeTimestamp != null ? { inceptionDate: ymdInTokyo(firstTradeTimestamp) } : {}),
  };
}
