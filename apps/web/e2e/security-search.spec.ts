import { expect, test } from "./strict-fixture";
import { demoMarket, installDemo, openView } from "./demo-portfolio";

const nvidia = {
  id: "sec-us-nvda-xnas", displaySymbol: "NVDA", name: "NVIDIA Corporation", assetType: "stock", country: "US", exchangeMic: "XNAS",
  exchangeLabel: "NASDAQ", currency: "USD", timezone: "America/New_York", providerSymbols: { yahoo: "NVDA" },
};

test("watchlist search shows local matches at once, then remote results, and registers one selection", async ({ page }) => {
  const market = demoMarket({ search: [nvidia] });
  market.quotes!.push({ key: "sec-us-nvda", price: 190, previousClose: 185, currency: "USD", venue: "US" });
  await installDemo(page, market);
  const registrations: unknown[] = [];
  const queries: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/market/registry") registrations.push(request.postDataJSON());
    if (path === "/api/market/search") queries.push((request.postDataJSON() as { q: string }).q);
  });
  await page.goto("/");
  await openView(page, "検索");
  await page.getByRole("button", { name: "銘柄を検索" }).click();
  const input = page.getByPlaceholder("銘柄名・ティッカー・投信を検索", { exact: true });
  const dialog = page.getByRole("dialog", { name: "銘柄検索" });

  await input.pressSequentially("トヨタ", { delay: 20 });
  await expect(dialog.getByText("トヨタ自動車", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "検索をクリア" }).click();
  await input.fill("NVDA");
  await expect(dialog.getByText("NVIDIA Corporation", { exact: true })).toBeVisible();
  await expect.poll(() => queries).toContain("NVDA");
  await page.getByRole("button", { name: "NVIDIA Corporationを追加" }).click();
  // Cloud clients add exactly one explicitly selected security per request.
  await expect.poll(() => registrations.length).toBe(1);
  expect(registrations[0]).toEqual({ securityIds: [expect.stringMatching(/^sec-us-nvda(?:-xnas)?$/u)] });
});
