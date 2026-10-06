import type { Page, Route } from "@playwright/test";
import type { Benchmark, Dividend, Quote, Split } from "@kabutora/domain/market";
import { MARKET_WIRE_VERSION, packHistory, packSeries, type HistoryPayload, type SnapshotPayload } from "../lib/market/market-wire";

/**
 * Serves the real market wire contract (`/api/market/snapshot`, `history`, `registry`, `search`)
 * from fixture data. Properties are read on every request, so a test can mutate the fixture to
 * simulate new prices or a split.
 */
export type HistoryFixture = { currency?: string; dates: string[]; closes: number[]; splits?: Split[]; dividends?: Dividend[] };

export type MarketFixture = {
  /** ISO timestamp of the snapshot; defaults to now. */
  generatedAt?: string;
  quotes?: Array<Partial<Quote> & { key: string; price: number }>;
  benchmarks?: Benchmark[];
  intraday?: Record<string, { times: number[]; prices: number[] }>;
  /** Return `null` to answer the history request with HTTP 500. */
  history?: Record<string, HistoryFixture> | ((from: string) => Record<string, HistoryFixture> | null);
  catalog?: string[];
  search?: unknown[];
  /** Simulated server + network time for the snapshot request. */
  snapshotDelayMs?: number;
};

const venueOf = (key: string): Quote["venue"] => (key.startsWith("sec-us-") ? "US" : key.includes("-fund-") ? "FUND" : key === "sec-fx-usdjpy" ? "FX" : "TSE");

function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16_777_619);
  return (value >>> 0).toString(36);
}

export function fixtureQuote(item: NonNullable<MarketFixture["quotes"]>[number], generatedAt: string): Quote {
  const time = Math.floor(Date.parse(generatedAt) / 1000);
  return {
    previousClose: null,
    time,
    session: "closed",
    venue: venueOf(item.key),
    currency: item.key.startsWith("sec-us-") ? "USD" : "JPY",
    fetchedAt: time,
    ...item,
  };
}

export function historyRecords(fixture: MarketFixture, from: string) {
  const history = typeof fixture.history === "function" ? fixture.history(from) : fixture.history ?? {};
  if (history === null) return null;
  return Object.fromEntries(Object.entries(history).map(([key, record]) => [key, packHistory({
    key, currency: record.currency ?? (key.startsWith("sec-us-") ? "USD" : "JPY"), dates: record.dates, closes: record.closes,
    splits: record.splits ?? [], dividends: record.dividends ?? [], fetchedAt: 1,
  }, from)]));
}

export function snapshotBody(fixture: MarketFixture): SnapshotPayload {
  const generatedAt = fixture.generatedAt ?? new Date().toISOString();
  const quotes = (fixture.quotes ?? []).map((item) => fixtureQuote(item, generatedAt));
  const intraday = Object.fromEntries(Object.entries(fixture.intraday ?? {}).map(([key, series]) => [key, packSeries(series)]));
  const historyRevision = hash(JSON.stringify(typeof fixture.history === "function" ? fixture.history("2000-01-01") : fixture.history ?? {}));
  const content = { quotes, benchmarks: fixture.benchmarks ?? [], intraday };
  return {
    version: MARKET_WIRE_VERSION,
    generatedAt: Math.floor(Date.parse(generatedAt) / 1000),
    revision: hash(JSON.stringify(content)),
    catalog: fixture.catalog ?? quotes.map((quote) => quote.key).filter((key) => key !== "sec-fx-usdjpy"),
    quotes,
    benchmarks: fixture.benchmarks ?? [],
    historyRevision,
    intradayRevision: hash(JSON.stringify(intraday)),
    intraday,
  };
}

const fulfill = (route: Route, json: unknown) => route.fulfill({ json });

export async function mockMarket(page: Page, fixture: MarketFixture) {
  await page.route("**/api/market/snapshot**", async (route) => {
    if (fixture.snapshotDelayMs) await new Promise((resolve) => setTimeout(resolve, fixture.snapshotDelayMs));
    // Always 200: Playwright's WebKit cannot fulfill a mocked 304. Unit and workerd tests cover 304.
    await fulfill(route, snapshotBody(fixture));
  });
  await page.route("**/api/market/history**", async (route) => {
    const from = new URL(route.request().url()).searchParams.get("from") ?? "";
    const records = historyRecords(fixture, from);
    if (!records) {
      await route.fulfill({ status: 500, json: { error: "fixture_history_rejected" } });
      return;
    }
    await fulfill(route, { version: MARKET_WIRE_VERSION, revision: snapshotBody(fixture).historyRevision, generatedAt: Math.floor(Date.now() / 1000), from, records, pending: [] } satisfies HistoryPayload);
  });
  await page.route("**/api/market/registry", (route) => fulfill(route, { added: [], rejected: [], size: 0 }));
  await page.route("**/api/market/search", (route) => fulfill(route, { results: fixture.search ?? [] }));
}

/** Weekday dates from `from` to `to`, inclusive. */
export function weekdays(from: string, to: string) {
  const dates: string[] = [];
  for (const cursor = new Date(`${from}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

/** Chromium formats JPY with a full-width ￥, WebKit with ¥. */
export const yen = (amount: string) => new RegExp(`[¥￥]${amount}(?![0-9])`, "u");
