import { expect, test } from "./strict-fixture";
import { installSyntheticPortfolio, syntheticPortfolio } from "./reliability-fixture";

/**
 * The user-visible contract behind "open the app and see current prices":
 * one market request, no serial waterfall, and the price painted soon after it returns.
 */
test("startup shows the latest price from a single market request", async ({ page }) => {
  const fixture = syntheticPortfolio(12, 120, 200);
  const target = fixture.seed.securities[0];
  fixture.quotes = fixture.quotes.map((quote) => quote.securityId === target.id ? { ...quote, price: "4321" } : quote);
  await installSyntheticPortfolio(page, fixture);
  await page.route("**/api/market/snapshot**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fallback();
  });
  const marketRequests: Array<{ path: string; at: number }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/market/")) marketRequests.push({ path: url.pathname, at: Date.now() });
  });

  await page.goto("/");
  const price = page.locator("tr.selectable").filter({ hasText: target.displaySymbol }).locator(".price-col strong");
  await expect(price).toHaveText(/4,321/u, { timeout: 30_000 });
  const visibleAt = Date.now();
  const snapshots = marketRequests.filter((request) => request.path === "/api/market/snapshot");
  expect(snapshots).toHaveLength(1);
  // 250 ms simulated network + one render; history and dividends must not sit in front of prices.
  expect(visibleAt - snapshots[0].at).toBeLessThan(2_500);

  // Nothing polls in the background while the page sits idle.
  await page.waitForTimeout(3_000);
  expect(marketRequests.filter((request) => request.path === "/api/market/snapshot")).toHaveLength(1);
});
