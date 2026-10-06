import type { Page } from "./strict-fixture";
import demo from "../data/demo-seed.json";
import { mockMarket, weekdays, type MarketFixture } from "./market-fixture";

export type DemoSeed = typeof demo & { watchlist?: unknown[] };

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/**
 * The demo ledger (100 × 7203 at ¥2,500 and 10 × AAPL at $200, both on 2025-04-01) priced at
 * ¥3,000 and $220 with USD/JPY 150: value ¥630,000, cost ¥550,000, day change +¥12,500.
 */
export function demoMarket(overrides: Partial<MarketFixture> = {}): MarketFixture {
  const dates = weekdays("2025-03-03", yesterday());
  // The latest closes match the quotes' previous closes, as Yahoo's data does.
  const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    quotes: [
      { key: "sec-7203", price: 3_000, previousClose: 2_950, name: "TOYOTA MOTOR CORP" },
      { key: "sec-us-aapl", price: 220, previousClose: 215, name: "Apple Inc.", venue: "US", currency: "USD" },
      { key: "sec-fx-usdjpy", price: 150, previousClose: 150, venue: "FX", currency: "JPY" },
    ],
    benchmarks: [
      { id: "usd-jpy", label: "USD/JPY", symbol: "JPY=X", value: 150, changeRatio: 0, time: Math.floor(Date.now() / 1000) },
      { id: "nikkei225", label: "日経225", symbol: "^N225", value: 40_000, changeRatio: 0.01, time: Math.floor(Date.now() / 1000) },
    ],
    history: {
      "sec-7203": { dates, closes: dates.map((date, index) => (date < recent ? 2_500 + (index % 10) * 10 : 2_950)) },
      "sec-us-aapl": { dates, closes: dates.map((date) => (date < recent ? 210 : 215)) },
      "sec-fx-usdjpy": { dates, closes: dates.map(() => 150) },
    },
    ...overrides,
  };
}

/** Serves the local ledger (GET) and records saves (POST). Returns the live saved ledger. */
export async function installDemo(page: Page, market: MarketFixture = demoMarket(), seed: DemoSeed = structuredClone(demo)) {
  const saved = { current: seed };
  await page.route("**/api/local/bootstrap", async (route) => {
    if (route.request().method() === "POST") {
      saved.current = route.request().postDataJSON();
      await route.fulfill({ json: { saved: true } });
    } else await route.fulfill({ json: saved.current });
  });
  await mockMarket(page, market);
  return saved;
}

/** Clicks the desktop or mobile navigation entry that is visible. */
export async function openView(page: Page, name: "一覧" | "取引" | "検索" | "配当" | "通知" | "設定") {
  const desktop: Record<typeof name, string> = { 一覧: "一覧", 取引: "取引履歴", 検索: "銘柄検索", 配当: "配当金", 通知: "通知", 設定: "設定" };
  const target = page.locator(`.desktop-nav button[aria-label="${desktop[name]}"]:visible, .mobile-nav button[aria-label="${name}"]:visible`).first();
  await target.click();
}
