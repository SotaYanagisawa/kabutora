import { expect, test } from "./strict-fixture";
import { yen } from "./market-fixture";
import { demoMarket, installDemo, openView } from "./demo-portfolio";

function dividendMarket(large = false) {
  const market = demoMarket();
  const history = market.history as Record<string, { dates: string[]; closes: number[]; dividends?: Array<{ date: string; amount: number }> }>;
  history["sec-7203"].dividends = [{ date: "2025-09-29", amount: large ? 1e12 : 30 }, { date: "2025-03-28", amount: 25 }];
  history["sec-us-aapl"].dividends = [{ date: "2025-08-11", amount: 0.26 }];
  return market;
}

test("dividends: units held before each ex-date, per account, in the summary, chart and ledger", async ({ page }) => {
  await installDemo(page, dividendMarket());
  await page.goto("/");
  // Overview: realized includes dividends (¥3,000 + $2.60 × 150 = ¥390).
  await expect(page.locator(".overview-page .daily-summary")).toContainText(/配当 \+[¥￥]3,390/u);
  await openView(page, "配当");
  const dividendPage = page.locator(".dividends-page");
  await expect(dividendPage.locator(".dividend-summary-total")).toHaveText(yen("3,390"));
  const breakdown = dividendPage.locator(".dividend-breakdown");
  await expect(breakdown.getByText("トヨタ自動車")).toBeVisible();
  await expect(breakdown.getByText("Apple")).toBeVisible();

  // The dividend view keeps its own filters.
  await dividendPage.locator(".dividend-filter-select").first().selectOption("US");
  await dividendPage.getByLabel("表示通貨").selectOption("USD");
  await expect(breakdown.getByText("トヨタ自動車")).toHaveCount(0);
  await expect(dividendPage.getByText(/\$2\.60/u).first()).toBeVisible();
  await openView(page, "一覧");
  await expect(page.locator('select[aria-label="表示通貨"]:visible').first()).toHaveValue("JPY");
});

test("keeps the compact dividend summary readable with very large totals", async ({ page }) => {
  await installDemo(page, dividendMarket(true));
  await page.goto("/");
  await openView(page, "配当");
  const summary = page.getByRole("region", { name: "配当金サマリー" });
  await expect(summary.locator(".dividend-summary-total")).toContainText("兆");
  const layout = await summary.evaluate((element) => {
    const viewportWidth = document.documentElement.clientWidth;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewportWidth, pageScrollWidth: document.documentElement.scrollWidth, height: rect.height };
  });
  expect(layout.left).toBeGreaterThanOrEqual(-0.5);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 0.5);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.height).toBeLessThanOrEqual(120);
});
