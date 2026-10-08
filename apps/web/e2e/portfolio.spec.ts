import { expect, test } from "./strict-fixture";
import { yen } from "./market-fixture";
import demo from "../data/demo-seed.json";
import { demoMarket, installDemo, openView } from "./demo-portfolio";
import { marketSessionWindows } from "../lib/market/market-session";

const total = (page: import("@playwright/test").Page) => page.locator(".overview-page .daily-stat-item.primary .daily-stat-val");

test("values the demo portfolio from one snapshot and one history request", async ({ page }) => {
  await installDemo(page);
  const requests: string[] = [];
  page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/market/")) requests.push(url.pathname); });
  await page.goto("/");
  await expect(total(page)).toHaveText(yen("630,000"));
  const summary = page.locator(".overview-page .daily-summary");
  await expect(summary).toContainText("+¥12,500");
  await expect(summary).toContainText("+¥8万");
  await expect(page.locator("tr.holding-widget-card")).toHaveCount(2);
  await expect(page.locator("tr.holding-widget-card").filter({ hasText: "トヨタ" }).locator(".price-col strong")).toHaveText("¥3,000");
  expect(requests.filter((path) => path === "/api/market/snapshot")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/market/history")).toHaveLength(1);

  // Currency and filters recompute instantly from the same data.
  await page.locator('select[aria-label="表示通貨"]:visible').first().selectOption("USD");
  await expect(total(page)).toHaveText("$4,200.00");
  await page.locator('select[aria-label="資産区分と国で絞り込み"]:visible, select[aria-label="資産区分で絞り込み"]:visible').first().selectOption("JP");
  await expect(total(page)).toHaveText("$2,000.00");
  expect(requests.filter((path) => path === "/api/market/snapshot")).toHaveLength(1);
});

test("startup shows the latest price from a single market request", async ({ page }) => {
  const market = demoMarket({ snapshotDelayMs: 250 });
  market.quotes![0] = { ...market.quotes![0], price: 4_321 };
  await installDemo(page, market);
  const snapshots: number[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/market/snapshot") snapshots.push(Date.now()); });
  await page.goto("/");
  await expect(page.locator("tr.holding-widget-card").filter({ hasText: "トヨタ" }).locator(".price-col strong")).toHaveText("¥4,321", { timeout: 30_000 });
  const visibleAt = Date.now();
  expect(snapshots).toHaveLength(1);
  expect(visibleAt - snapshots[0]).toBeLessThan(2_500);
  // Nothing loops in the background while the page sits idle.
  await page.waitForTimeout(3_000);
  expect(snapshots).toHaveLength(1);
});

test("holding cards keep the whole name and show PTS and after-hours trades against the regular close", async ({ page }) => {
  const seed = structuredClone(demo) as typeof demo;
  const mufg = { ...demo.securities[0], id: "sec-8306-xtks", canonicalSymbol: "8306", displaySymbol: "8306", providerSymbols: { yahoo: "8306.T" }, name: "三菱ＵＦＪフィナンシャル・グループ" };
  seed.securities.push(mufg);
  seed.transactions.push({ ...demo.transactions[0], id: "demo-mufg-buy", securityId: mufg.id, original: { ...demo.transactions[0].original, ticker: "8306.T", name: mufg.name } });
  const now = Math.floor(Date.now() / 1000);
  const market = demoMarket();
  market.quotes = [
    // A close from three days ago: the long name must not be cut by the date.
    { key: "sec-8306", price: 2_120, previousClose: 2_100, time: now - 3 * 86_400, session: "closed" },
    { key: "sec-7203", price: 3_030, previousClose: 2_950, time: now - 60, session: "pts_night", venue: "JNX", regularPrice: 3_000, regularTime: now - 6 * 3_600 },
    { key: "sec-us-aapl", price: 221.1, previousClose: 215, time: now - 60, session: "after_hours", venue: "US", currency: "USD", regularPrice: 220, regularTime: now - 3 * 3_600 },
    ...market.quotes!.filter((quote) => quote.key === "sec-fx-usdjpy"),
  ];
  await installDemo(page, market, seed);
  await page.goto("/");
  const card = (text: string) => page.locator("tr.holding-widget-card").filter({ hasText: text });
  await expect(card("三菱").locator(".widget-ticker")).toHaveText("三菱ＵＦＪFG");
  for (const name of await page.locator(".widget-ticker").all()) {
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  // A close from another day shows only its date, so it never pushes the name aside.
  await expect(card("三菱").locator(".widget-fetched-time")).toHaveText(/^\d{1,2}\/\d{1,2}$/u);
  await expect(card("三菱").locator(".widget-sec-name")).toHaveText("8306 · 東証");
  await expect(card("トヨタ").locator(".widget-row-status")).toContainText("PTS+1.00%");
  await expect(card("トヨタ").locator(".price-col strong")).toHaveText("¥3,030");
  await expect(card("AAPL").locator(".widget-row-status")).toContainText("時間外+0.50%");
  // No price, day change or gain is cut off — also with every glyph ~10% wider, as on a device whose font runs wider.
  const clipped = () => page.locator(".widget-card-row, .widget-price strong, .widget-row-day strong, .widget-gain-amount").evaluateAll((items) =>
    items.filter((item) => item.scrollWidth > item.clientWidth + 1).map((item) => item.textContent));
  expect(await clipped()).toEqual([]);
  await page.addStyleTag({ content: ".holding-widget-card * { letter-spacing: 0.06em !important; }" });
  expect(await clipped()).toEqual([]);
  await card("トヨタ").click();
  const split = page.locator(".detail-session-split");
  await expect(split.locator(".detail-session-cell").first()).toContainText("+1.69%");
  await expect(split.locator(".detail-session-cell").first().locator(".detail-session-price span").first()).toHaveText(new RegExp(`東証終値 ${yen("3,000").source}`, "u"));
  await expect(split.locator(".detail-session-cell.extended")).toContainText("PTS東証終値比+1.00%");
  await expect(split.locator(".detail-session-cell.extended")).toContainText(yen("3,000")); // +¥3,000 on 100 shares
});

test("the 1D chart shades the trading sessions of the markets shown", async ({ page }) => {
  // Thu 07:30 JST / Wed 18:30 EDT: the last 24 hours hold a full TSE day, PTS and a US day.
  const now = Date.parse("2026-10-07T22:30:00Z");
  await page.clock.setFixedTime(now);
  const series = (market: "JP" | "US", base: number) => {
    const times: number[] = [];
    for (const window of marketSessionWindows(market, now - 30 * 3_600_000, now)) {
      if (window.kind !== "lunch") for (let time = window.start; time < window.end; time += 1_800_000) times.push(Math.floor(time / 1000));
    }
    return { times, prices: times.map((_, index) => base * (1 + 0.001 * (index % 7))) };
  };
  const market = demoMarket({ generatedAt: new Date(now).toISOString(), intraday: { "sec-7203": series("JP", 3_000), "sec-us-aapl": series("US", 220) } });
  market.quotes = market.quotes!.map((quote) => ({ ...quote, time: Math.floor(now / 1000) - 60, fetchedAt: Math.floor(now / 1000) }));
  await installDemo(page, market);
  await page.goto("/");
  await expect(total(page)).toBeVisible();
  const labels = page.locator(".daily-chart .chart-session-label");
  await page.locator(".daily-range .chart-range-presets").getByRole("button", { name: "1D", exact: true }).click();
  await expect(labels.filter({ hasText: "東証" }).first()).toBeVisible();
  await expect(labels.filter({ hasText: "米国" })).toHaveCount(1);
  await page.locator('select[aria-label="資産区分と国で絞り込み"]:visible, select[aria-label="資産区分で絞り込み"]:visible').first().selectOption("JP");
  await expect(labels.filter({ hasText: "米国" })).toHaveCount(0);
  await expect(labels.filter({ hasText: "東証" }).first()).toBeVisible();
  await page.locator('select[aria-label="資産区分と国で絞り込み"]:visible, select[aria-label="資産区分で絞り込み"]:visible').first().selectOption("US");
  await expect(labels.filter({ hasText: "東証" })).toHaveCount(0);
  await expect(labels.filter({ hasText: "米国" })).toHaveCount(1);
  // Daily ranges have no session bands.
  await page.locator(".daily-range .chart-range-presets").getByRole("button", { name: "1M", exact: true }).click();
  await expect(page.locator(".daily-chart .chart-session-band")).toHaveCount(0);
});

test("re-reads once soon after the server answered with quotes it had not refreshed yet", async ({ page }) => {
  const market = demoMarket();
  const stale = Math.floor(Date.now() / 1000) - 120;
  market.quotes = market.quotes!.map((quote) => ({ ...quote, fetchedAt: stale }));
  await installDemo(page, market);
  const snapshots: number[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/market/snapshot") snapshots.push(Date.now()); });
  await page.goto("/");
  await expect(total(page)).toHaveText(yen("630,000"));
  await expect.poll(() => snapshots.length, { timeout: 4_000 }).toBe(2);
  expect(snapshots[1] - snapshots[0]).toBeLessThan(3_000);
  // Still stale (the fixture never refreshes): no loop.
  await page.waitForTimeout(3_000);
  expect(snapshots).toHaveLength(2);
});

test("trade entry, edit and delete update holdings and the saved ledger", async ({ page }) => {
  const saved = await installDemo(page);
  await page.goto("/");
  await expect(total(page)).toHaveText(yen("630,000"));
  await openView(page, "取引");
  await page.getByRole("button", { name: "取引を追加" }).click();
  const form = page.locator("form.trade-modal");
  await form.getByLabel("数量", { exact: true }).fill("50");
  await form.getByLabel(/^価格（/u).fill("2,800");
  await form.getByRole("button", { name: "端末に保存", exact: true }).click();
  await expect.poll(() => saved.current.transactions.length).toBe(3);
  const created = saved.current.transactions.find((item) => item.source === "manual")!;
  expect(created).toMatchObject({ securityId: "sec-7203-xtks", quantity: "50", pricePerShare: "2800", grossAmount: "140000", type: "BUY" });
  await openView(page, "一覧");
  await expect(total(page)).toHaveText(yen("780,000"));

  await openView(page, "取引");
  await page.getByRole("button", { name: /トヨタ.*を編集/u }).first().click();
  await form.getByLabel("数量", { exact: true }).fill("20");
  await form.getByRole("button", { name: "変更を端末に保存" }).click();
  await expect.poll(() => saved.current.transactions.find((item) => item.id === created.id)?.grossAmount).toBe("56000");
  await page.getByRole("button", { name: /トヨタ.*を削除/u }).first().click();
  await page.getByRole("alertdialog").getByRole("button", { name: "削除する", exact: true }).click();
  await expect.poll(() => saved.current.transactions.length).toBe(2);
  await openView(page, "一覧");
  await expect(total(page)).toHaveText(yen("630,000"));
});

test("dialogs close on Escape and return focus to the control that opened them", async ({ page }) => {
  await installDemo(page);
  await page.goto("/");
  await expect(total(page)).toHaveText(yen("630,000"));
  await openView(page, "取引");
  const add = page.getByRole("button", { name: "取引を追加" });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "取引を記録" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("form.trade-modal")).toHaveCount(0);
  await expect(add).toBeFocused();

  const remove = page.getByRole("button", { name: /トヨタ.*を削除/u }).first();
  await remove.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(remove).toBeFocused();
});

test("a long ledger renders one layout in pages", async ({ page }) => {
  const seed = structuredClone(demo);
  const base = seed.transactions[0];
  seed.transactions = Array.from({ length: 300 }, (_, index) => ({ ...base, id: `bulk-${index}`, quantity: "1", grossAmount: "2500", tradeDate: new Date(Date.UTC(2024, 0, 1 + index)).toISOString() }));
  await installDemo(page, demoMarket(), seed);
  await page.goto("/");
  await openView(page, "取引");
  const rows = page.locator(".activity-page .ledger-row, .activity-page .ledger-card");
  await expect(rows).toHaveCount(120);
  // Scrolling toward the end loads the next pages.
  await expect.poll(async () => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    return rows.count();
  }).toBe(300);
  await expect(page.locator(".ledger-more")).toHaveCount(0);
});
