import { test, expect } from "./strict-fixture";
import { installSyntheticPortfolio, syntheticPortfolio } from "./reliability-fixture";

test("holdings grid renders compact micro-widget cards with hero daily change and sorting", async ({ page }) => {
  // Install synthetic portfolio with multiple holdings (JP, US, Funds)
  await installSyntheticPortfolio(page, syntheticPortfolio(6, 40, 200));
  await page.goto("/");

  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".market-health")).not.toContainText("取得中");

  // Verify the holdings container has the grid-view class and the grid table is visible
  const holdingsContainer = page.locator(".holdings-table.grid-view");
  await expect(holdingsContainer).toBeVisible({ timeout: 10_000 });

  const table = page.locator("table.holdings-table-content.is-grid");
  await expect(table).toBeVisible({ timeout: 10_000 });

  // Verify cards are rendered as selectable widget cards
  const cards = table.locator("tr.holding-widget-card");
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(0);

  // First card: verify presence of key micro-widget elements
  const firstCard = cards.first();
  await expect(firstCard.locator(".widget-ticker")).toBeVisible();
  await expect(firstCard.locator(".widget-sec-name")).toBeVisible();
  await expect(firstCard.locator(".price-col.widget-price strong")).toBeVisible();
  await expect(firstCard.locator(".day-col.widget-day-val strong")).toBeVisible();
  await expect(firstCard.locator(".widget-total-gain .widget-gain-percent")).toBeVisible();

  // Verify sort chips toolbar is present and functional
  const sortToolbar = page.locator(".holdings-header-bar");
  await expect(sortToolbar).toBeVisible();

  // Click 評価額 sort chip within toolbar
  const valueSortChip = sortToolbar.getByRole("button", { name: /評価額/u });
  await expect(valueSortChip).toBeVisible();
  await valueSortChip.click();
  await expect(valueSortChip).toHaveClass(/active/);
  await page.waitForTimeout(300);

  // Click 含み損益 sort chip within toolbar
  const gainSortChip = sortToolbar.getByRole("button", { name: /含み損益/u });
  await expect(gainSortChip).toBeVisible();
  await gainSortChip.click();
  await expect(gainSortChip).toHaveClass(/active/);
  await page.waitForTimeout(300);

  // Click 前日比 sort chip within toolbar
  const daySortChip = sortToolbar.getByRole("button", { name: /前日比/u });
  await expect(daySortChip).toBeVisible();
  await daySortChip.click();
  await expect(daySortChip).toHaveClass(/active/);
  await page.waitForTimeout(300);

  // Clicking a card navigates to the security detail view
  await firstCard.click();
  await expect(page.locator(".security-detail-page")).toBeVisible({ timeout: 10_000 });

  // Going back returns to the main grid view
  const backButton = page.locator(".detail-back-button");
  await expect(backButton).toBeVisible();
  await backButton.click();
  await expect(page.locator(".security-detail-page")).toHaveCount(0);
  await expect(holdingsContainer).toBeVisible({ timeout: 10_000 });
});
