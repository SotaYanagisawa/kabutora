import { expect, test } from "./strict-fixture";
import { yen } from "./market-fixture";
import { demoMarket, installDemo, openView } from "./demo-portfolio";

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
