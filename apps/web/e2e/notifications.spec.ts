import { expect, test } from "./strict-fixture";
import { demoMarket, installDemo, openView } from "./demo-portfolio";

test("price notices can be marked read and stay read after reload", async ({ page }) => {
  const market = demoMarket();
  // Today's quote is 8% above the previous close: one PRICE_UP notice for Toyota.
  market.quotes![0] = { key: "sec-7203", price: 3_240, previousClose: 3_000 };
  const history = market.history as Record<string, { dates: string[]; closes: number[] }>;
  history["sec-7203"].closes = history["sec-7203"].closes.map(() => 3_000);
  await installDemo(page, market);
  await page.goto("/");
  await expect(page.locator(".notification-badge:visible").first()).toBeVisible();
  await openView(page, "通知");
  const notifPage = page.locator(".notification-page");
  const row = notifPage.locator(".notification-row").filter({ hasText: "トヨタ自動車が急騰" });
  await expect(row).toHaveClass(/unread/);
  await expect(row).toContainText("+8.00%");
  await notifPage.locator(".notification-read-all-btn").click();
  await expect(row).toHaveClass(/read/);
  await expect(page.locator(".notification-badge:visible")).toHaveCount(0);

  await page.reload();
  await openView(page, "通知");
  await expect(notifPage.locator(".notification-row").filter({ hasText: "トヨタ自動車が急騰" })).toHaveClass(/read/);
  await expect(page.locator(".notification-badge:visible")).toHaveCount(0);
});
