import { expect, test } from "./strict-fixture";
import { demoMarket, installDemo, openView } from "./demo-portfolio";
import { weekdays, yen } from "./market-fixture";

/**
 * Regression for the double split: 100 shares bought at ¥2,500 before a 1→2 split are 200 shares at
 * ¥1,250, whatever order the data arrives in and however often prices refresh.
 */
test("a stock split is applied exactly once across views and refreshes", async ({ page }) => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const dates = weekdays("2025-03-03", yesterday);
  const market = demoMarket();
  market.quotes![0] = { key: "sec-7203", price: 1_500, previousClose: 1_480 };
  market.history = {
    ...(market.history as Record<string, never>),
    "sec-7203": { dates, closes: dates.map((date) => (date < "2025-10-01" ? 1_300 : 1_450)), splits: [{ date: "2025-10-01", ratio: 2 }] },
  };
  await installDemo(page, market);
  await page.goto("/");
  const total = page.locator(".overview-page .daily-stat-item.primary .daily-stat-val");
  await expect(total).toHaveText(yen("630,000"));

  // Detail page: today's share units and cost.
  await page.locator("tr.holding-widget-card").filter({ hasText: "トヨタ" }).click();
  const detail = page.locator(".security-detail-page");
  await expect(detail).toContainText("200株");
  await expect(detail).toContainText(yen("1,250"));
  await expect(detail).toContainText(yen("300,000"));

  // Ledger: the entered row is shown in today's units with the split visible.
  await openView(page, "取引");
  const row = page.locator(".ledger-row:visible, .ledger-card:visible").filter({ hasText: "トヨタ" });
  await expect(row).toContainText("200株");
  await expect(row).toContainText("分割 ×2");
  await expect(row).toContainText(yen("1,250"));

  // Notification with before/after holdings.
  await openView(page, "通知");
  await expect(page.getByText("トヨタ自動車の株式分割").first()).toBeVisible();
  await expect(page.locator("main")).toContainText("100株 → 200株");

  // Repeated refreshes (and a later price) never apply the split again. Phones refresh by reopening.
  const refresh = async () => {
    const button = page.locator('button[aria-label="市場データを更新"]:visible');
    if (await button.count()) {
      await button.first().click();
      await expect(page.locator(".toast")).toBeVisible();
    } else {
      await page.reload();
      await expect(page.locator(".app-shell")).toBeVisible();
      await page.waitForLoadState("networkidle");
    }
  };
  for (let attempt = 0; attempt < 3; attempt += 1) await refresh();
  market.quotes![0] = { key: "sec-7203", price: 1_600, previousClose: 1_500 };
  await refresh();
  await openView(page, "一覧");
  await expect(total).toHaveText(yen("650,000"));
});
