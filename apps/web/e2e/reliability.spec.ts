import { expect, test } from "./strict-fixture";
import { yen } from "./market-fixture";
import { demoMarket, installDemo, openView } from "./demo-portfolio";

const total = (page: import("@playwright/test").Page) => page.locator(".overview-page .daily-stat-item.primary .daily-stat-val");

test("a reopened app paints saved prices before the network answers", async ({ page }) => {
  const market = demoMarket();
  await installDemo(page, market);
  await page.goto("/");
  await expect(total(page)).toHaveText(yen("630,000"));
  // Let the saved snapshot land, then make the network slow.
  await page.waitForTimeout(300);
  market.snapshotDelayMs = 4_000;
  market.quotes![0] = { key: "sec-7203", price: 3_100, previousClose: 2_950 };
  await page.reload();
  await expect(total(page)).toHaveText(yen("630,000"), { timeout: 2_000 });
  await expect(total(page)).toHaveText(yen("640,000"), { timeout: 10_000 });
});

test("a failed history request keeps prices and the rest of the app working", async ({ page, applicationErrors }) => {
  await installDemo(page, demoMarket({ history: () => null }));
  await page.goto("/");
  await expect(total(page)).toHaveText(yen("630,000"));
  await openView(page, "取引");
  await expect(page.locator(".ledger-row:visible, .ledger-card:visible")).toHaveCount(2);
  // The fixture answers history with HTTP 500 on purpose.
  const intended = (error: string) => error.includes("/api/market/history") || error.includes("status of 500");
  expect(applicationErrors.some(intended)).toBe(true);
  applicationErrors.splice(0, applicationErrors.length, ...applicationErrors.filter((error) => !intended(error)));
});

test("filter changes recompute without market requests and stay responsive", async ({ page }) => {
  await installDemo(page);
  await page.goto("/");
  await expect(total(page)).toHaveText(yen("630,000"));
  const requests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/market/")) requests.push(request.url()); });
  const market = page.locator('select[aria-label="資産区分と国で絞り込み"]:visible, select[aria-label="資産区分で絞り込み"]:visible').first();
  const started = Date.now();
  for (let index = 0; index < 20; index += 1) await market.selectOption(index % 2 ? "ALL" : "US");
  await expect(total(page)).toHaveText(yen("630,000"));
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(requests).toEqual([]);
});

test("missing USD/JPY leaves converted totals explicitly incomplete", async ({ page }) => {
  const market = demoMarket({ benchmarks: [] });
  market.quotes = market.quotes!.filter((quote) => quote.key !== "sec-fx-usdjpy");
  (market.history as Record<string, unknown>)["sec-fx-usdjpy"] = { dates: [], closes: [] };
  await installDemo(page, market);
  await page.goto("/");
  await expect(page.getByText("為替レートを確認できないため", { exact: false })).toBeVisible();
});
