import { expect, test, type Page } from "./strict-fixture";
import { resolve as resolvePath } from "node:path";

const generatedAt = "2026-08-31T12:00:00.000Z";

async function setupPage(page: Page) {
  await page.route("**/api/local/bootstrap", (route) => route.fulfill({
    path: resolvePath(process.cwd(), "apps/web/data/demo-seed.json"),
    contentType: "application/json",
  }));
  await page.route("**/api/market/quotes", async (route) => {
    await route.fulfill({ json: {
      generatedAt,
      marketSessions: [],
      quotes: [
        { securityId: "sec-7203-xtks", symbol: "7203", exchangeMic: "XTKS", currency: "JPY", price: "3000", previousRegularClose: "2950", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "cached", provider: "fixture", session: "closed", priceType: "official_close", venueCode: "TSE", validationStatus: "valid" },
        { securityId: "sec-us-aapl-xnas", symbol: "AAPL", exchangeMic: "XNAS", currency: "USD", price: "220", previousRegularClose: "218", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "cached", provider: "fixture", session: "closed", priceType: "official_close", venueCode: "US", validationStatus: "valid" },
      ],
      intraday: [],
      failures: [],
      coverage: { requested: 2, returned: 2, fresh: 0, stale: 0, suspect: 0 },
    } });
  });
  await page.route("**/api/market/history", async (route) => {
    await route.fulfill({ json: {
      generatedAt,
      marketSessions: [],
      bars: [
        { securityId: "sec-fx-usdjpy", date: "2026-08-31", close: "150", provider: "fixture" },
      ],
      corporateActions: [],
      inceptionDates: {},
      failures: [],
      coverage: { requested: 1, returned: 1 },
    } });
  });
  await page.route("**/api/market/benchmarks**", (route) => route.fulfill({ json: {
    generatedAt,
    marketSessions: [],
    benchmarks: [],
    failures: [],
  } }));

  await page.goto("/");
  await expect(page.getByRole("button", { name: "通知", exact: true })).toBeVisible({ timeout: 20_000 });
}

test("reliably marks notifications as read, clears unread badge, and persists on reload", async ({ page }) => {
  await setupPage(page);

  // Unread badge should initially be present on notifications tab
  const notifNavBtn = page.getByRole("button", { name: "通知", exact: true });
  await expect(notifNavBtn).toBeVisible();

  // Navigate to Notifications tab
  await notifNavBtn.click();
  const notifPage = page.locator(".notification-page");
  await expect(notifPage).toBeVisible();

  // At least one notification card is visible (Apple split from corporate actions seed)
  const notifRow = notifPage.locator(".notification-row").first();
  await expect(notifRow).toBeVisible();
  await expect(notifRow).toHaveClass(/unread/);

  // "既読 (X)" button is visible in bottom controls
  const readAllBtn = notifPage.locator(".notification-read-all-btn");
  await expect(readAllBtn).toBeVisible();
  await expect(readAllBtn).toContainText("既読");

  // Click "既読" button to mark all as read
  await readAllBtn.click();

  // Immediately, the read-all button must disappear
  await expect(readAllBtn).not.toBeVisible();

  // The notification row must transition to read state
  await expect(notifRow).toHaveClass(/read/);
  await expect(notifRow.locator(".notification-status-indicator")).toContainText("既読");

  // Bottom navigation unread badge must be gone
  await expect(notifNavBtn.locator(".notification-badge")).not.toBeVisible();

  // Tab filtering works as expected
  await notifPage.getByRole("tab", { name: "企業イベント" }).click();
  await expect(notifRow).toBeVisible();

  await notifPage.getByRole("tab", { name: "値動き" }).click();
  await expect(notifPage.getByText("値動き通知はありません")).toBeVisible();

  await notifPage.getByRole("tab", { name: "すべて" }).click();
  await expect(notifRow).toBeVisible();

  // Reload page to verify persistence in localStorage
  await page.reload();
  await expect(notifNavBtn).toBeVisible({ timeout: 20_000 });
  await notifNavBtn.click();
  await expect(notifPage).toBeVisible();

  // Read state must be retained after reload
  await expect(notifRow).toHaveClass(/read/);
  await expect(readAllBtn).not.toBeVisible();
  await expect(notifNavBtn.locator(".notification-badge")).not.toBeVisible();
});
