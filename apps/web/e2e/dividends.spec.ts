import { expect, test, type Page } from "./strict-fixture";
import { resolve as resolvePath } from "node:path";

const generatedAt = new Date().toISOString();
const firstIntradayAt = new Date(Date.parse(generatedAt) - 60 * 60_000).toISOString();

async function openDividendFixture(page: Page, { largeDividend = false }: { largeDividend?: boolean } = {}) {
  await page.route("**/api/local/bootstrap", (route) => route.fulfill({
    path: resolvePath(process.cwd(), "apps/web/data/demo-seed.json"),
    contentType: "application/json",
  }));
  await page.route("**/api/market/quotes", async (route) => {
    const request = route.request().postDataJSON() as { securityIds?: string };
    const ids = request.securityIds?.split(",").filter(Boolean) ?? [];
    await route.fulfill({ json: {
      generatedAt,
      marketSessions: [],
      quotes: ids.flatMap((securityId) => {
        if (securityId === "sec-7203-xtks") return [{ securityId, symbol: "7203", exchangeMic: "XTKS", currency: "JPY", price: "3000", previousRegularClose: "2950", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "cached", provider: "fixture", session: "closed", priceType: "official_close", venueCode: "TSE", validationStatus: "valid" }];
        if (securityId === "sec-us-aapl-xnas") return [{ securityId, symbol: "AAPL", exchangeMic: "XNAS", currency: "USD", price: "220", previousRegularClose: "218", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "cached", provider: "fixture", session: "closed", priceType: "official_close", venueCode: "US", validationStatus: "valid" }];
        return [];
      }),
      intraday: ids.flatMap((securityId) => securityId.startsWith("sec-fx-") ? [] : [
        { securityId, timestamp: firstIntradayAt, price: securityId.includes("aapl") ? "218" : "2950", provider: "fixture" },
        { securityId, timestamp: generatedAt, price: securityId.includes("aapl") ? "220" : "3000", provider: "fixture" },
      ]), failures: [],
      coverage: { requested: ids.length, returned: ids.length, fresh: 0, stale: 0, suspect: 0 },
    } });
  });
  await page.route("**/api/market/history", async (route) => {
    const request = route.request().postDataJSON() as { securityIds?: string; from?: string };
    const ids = request.securityIds?.split(",").filter(Boolean) ?? [];
    if (request.from && request.from < "2025-04-01") {
      await route.fulfill({ status: 500, json: { message: "Pre-purchase dividends must not expand FX or price-history requirements" } });
      return;
    }
    await route.fulfill({ json: {
      generatedAt,
      marketSessions: [],
      bars: ids.flatMap((securityId) => [
        { securityId, date: "2025-04-01", close: securityId === "sec-fx-usdjpy" ? "150" : "100", provider: "fixture" },
        { securityId, date: "2026-08-31", close: securityId === "sec-fx-usdjpy" ? "150" : "120", provider: "fixture" },
      ]),
      corporateActions: [],
      inceptionDates: {}, failures: [],
      coverage: { requested: ids.length, returned: ids.length },
    } });
  });
  await page.route("**/api/market/distributions", async (route) => {
    const request = route.request().postDataJSON() as { securityIds?: string };
    const ids = request.securityIds?.split(",").filter(Boolean) ?? [];
    const hasToyota = ids.some((id) => id === "sec-7203" || id === "sec-7203-xtks");
    const hasApple = ids.some((id) => id === "sec-us-aapl" || id === "sec-us-aapl-xnas");
    await route.fulfill({ json: {
      generatedAt,
      distributions: [
        ...(hasToyota ? [{
          id: "sec-7203-xtks-cash_dividend-20260327",
          securityId: "sec-7203-xtks",
          type: "CASH_DIVIDEND" as const,
          exDate: "2026-03-27",
          amountPerUnit: largeDividend ? "98765432100" : "30",
          distributionUnit: "1",
          currency: "JPY",
          sourceProvider: "fixture_reported",
          confidence: "reported" as const,
          status: "estimated" as const,
        }] : []),
        ...(hasApple ? [{
          id: "sec-us-aapl-xnas-cash_dividend-20260515",
          securityId: "sec-us-aapl-xnas",
          type: "CASH_DIVIDEND" as const,
          exDate: "2026-05-15",
          amountPerUnit: "0.25",
          distributionUnit: "1",
          currency: "USD",
          sourceProvider: "fixture_reported",
          confidence: "reported" as const,
          status: "estimated" as const,
        }] : []),
        ...(hasApple ? [{
          id: "sec-us-aapl-xnas-cash_dividend-20200101",
          securityId: "sec-us-aapl-xnas",
          type: "CASH_DIVIDEND" as const,
          exDate: "2020-01-01",
          amountPerUnit: "0.20",
          distributionUnit: "1",
          currency: "USD",
          sourceProvider: "fixture_reported",
          confidence: "reported" as const,
          status: "paid" as const,
        }] : []),
      ],
      corporateActions: [],
      coverage: ids.map((securityId) => ({ securityId, coveredFrom: "2000-01-01", checkedThrough: "2026-08-31", checkedAt: generatedAt, eventCount: securityId.startsWith("sec-7203") ? 1 : 2, status: "ready", sourceProvider: "fixture_reported" })),
      failures: [],
    } });
  });
  await page.route("**/api/market/benchmarks**", (route) => route.fulfill({ json: {
    generatedAt,
    marketSessions: [],
    benchmarks: [{ id: "usd-jpy", label: "USD/JPY", symbol: "JPY=X", value: 150, changeRatio: 0, marketTimestamp: generatedAt, freshness: "cached", fetchedAt: generatedAt }],
    failures: [],
  } }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^配当(?:金)?$/u })).toBeVisible({ timeout: 20_000 });
}

test("calculates historical dividends and exposes them in summary, charts and ledger", async ({ page }) => {
  await openDividendFixture(page);
  await page.getByRole("button", { name: /^配当(?:金)?$/u }).click();

  const dividendPage = page.locator(".dividends-page");
  await expect(dividendPage.getByRole("region", { name: "配当金サマリー" })).toBeVisible();

  // Both JP (¥3,000) and split-adjusted US holdings (20 sh * $0.25 = $5 * 150 = ¥750) are recognized: Total ¥3,750.
  // The 2020 Apple event predates the 2025 purchase and must remain excluded.
  await expect(dividendPage.getByText(/[¥￥]3,750/u).first()).toBeVisible();
  await expect(dividendPage.getByText("トヨタ自動車", { exact: true }).first()).toBeVisible();
  // Top summary shows NISA breakdown numbers
  await expect(dividendPage.getByText("NISA", { exact: true })).toBeVisible();
  await expect(dividendPage.getByText(/非課税/u).first()).toBeVisible();

  // Monthly line chart is visible
  await expect(dividendPage.locator(".dividend-bar-chart")).toBeVisible();

  // Test switching between 銘柄別 and 受取履歴
  await dividendPage.getByRole("tab", { name: "受取履歴", exact: true }).click();
  await expect(dividendPage.getByText("公開情報", { exact: true }).first()).toBeVisible();
  await dividendPage.getByRole("tab", { name: "銘柄別", exact: true }).click();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("トヨタ自動車")).toBeVisible();

  // Test tax mode toggle: Net mode estimates withholding, then switch back to gross
  await dividendPage.getByRole("tab", { name: "税後", exact: true }).click();
  await expect(dividendPage.getByRole("tab", { name: "税後", exact: true })).toHaveClass(/active/);
  await dividendPage.getByRole("tab", { name: "税前", exact: true }).click();
  await expect(dividendPage.getByRole("tab", { name: "税前", exact: true })).toHaveClass(/active/);

  // Test ledger search filter
  await dividendPage.getByRole("tab", { name: "受取履歴", exact: true }).click();
  const searchInput = dividendPage.getByRole("searchbox", { name: "受取履歴を検索" });
  await searchInput.fill("Apple");
  await expect(dividendPage.locator(".dividend-ledger").getByText("Apple")).toBeVisible();
  await expect(dividendPage.locator(".dividend-ledger").getByText("トヨタ自動車")).not.toBeVisible();
  await searchInput.fill("");
  await dividendPage.getByRole("tab", { name: "銘柄別", exact: true }).click();


  // Test asset category filtering (日本株 vs 米国株 vs 全資産)
  await dividendPage.locator(".dividend-filter-select").first().selectOption("JP");
  await expect(dividendPage.getByText(/[¥￥]3,000/u).first()).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("トヨタ自動車")).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("Apple")).not.toBeVisible();

  await dividendPage.locator(".dividend-filter-select").first().selectOption("US");
  await expect(dividendPage.getByText(/[¥￥]750/u).first()).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("Apple")).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("トヨタ自動車")).not.toBeVisible();

  await dividendPage.locator(".dividend-filter-select").first().selectOption("ALL");
  await expect(dividendPage.getByText(/[¥￥]3,750/u).first()).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("トヨタ自動車")).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("Apple")).toBeVisible();



  // Check Overview integration
  await page.getByRole("button", { name: "一覧", exact: true }).click();
  const realized = page.getByText("確定損益", { exact: true }).locator("..");
  await expect(realized).toContainText(/配当 \+[¥￥]3,750/u);
  await expect(page.getByLabel("ポートフォリオ評価額の推移")).toBeVisible();
  const chartMetric = page.getByRole("group", { name: "チャート指標" });
  for (const range of ["1D", "1W", "YTD", "ALL"]) {
    await page.getByRole("button", { name: range, exact: true }).click();
    await chartMetric.getByRole("button", { name: "評価額", exact: true }).click();
    await expect(page.getByLabel("ポートフォリオ評価額の推移")).toBeVisible();
    await chartMetric.getByRole("button", { name: "配当込み", exact: true }).click();
    await expect(page.getByLabel("配当込みポートフォリオ投資成果の推移")).toBeVisible();
  }
});

test("maintains independent filter preferences between summary and dividend views", async ({ page }) => {
  await openDividendFixture(page);

  // 1. Select JP and JPY in Summary overview filter
  const overviewFilter = page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  const overviewCurrency = page.locator('.header-filters select[aria-label="表示通貨"]:visible, .overview-filters select[aria-label="表示通貨"]:visible');
  await expect(overviewFilter).toBeVisible();
  await overviewFilter.selectOption("JP");
  await overviewCurrency.selectOption("JPY");

  // 2. Navigate to Dividends page
  await page.getByRole("button", { name: /^配当(?:金)?$/u }).click();
  const dividendPage = page.locator(".dividends-page");
  await expect(dividendPage).toBeVisible();

  // Verify reload button is not present in bottom controls
  await expect(dividendPage.locator(".dividend-refresh-btn")).not.toBeVisible();

  // 3. Verify Dividend view is still ALL (independent memory) and shows both Toyota and Apple
  const dividendFilter = dividendPage.locator(".dividend-filter-select").first();
  const dividendCurrency = dividendPage.getByLabel("表示通貨");
  await expect(dividendFilter).toHaveValue("ALL");
  await expect(dividendPage.locator(".dividend-breakdown").getByText("トヨタ自動車")).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("Apple")).toBeVisible();

  // 4. Change Dividend filter to US and currency to USD
  await dividendFilter.selectOption("US");
  await dividendCurrency.selectOption("USD");
  await expect(dividendPage.locator(".dividend-breakdown").getByText("Apple")).toBeVisible();
  await expect(dividendPage.locator(".dividend-breakdown").getByText("トヨタ自動車")).not.toBeVisible();
  await expect(dividendPage.getByText(/\$5\.00/u).first()).toBeVisible();

  // 5. Navigate back to Summary (一覧)
  await page.getByRole("button", { name: "一覧", exact: true }).click();

  // 6. Verify Summary filter remains JP and currency remains JPY
  await expect(overviewFilter).toHaveValue("JP");
  await expect(overviewCurrency).toHaveValue("JPY");
});

test("keeps the compact dividend summary readable with very large totals", async ({ page }) => {
  await openDividendFixture(page, { largeDividend: true });
  await page.getByRole("button", { name: /^配当(?:金)?$/u }).click();

  const summary = page.getByRole("region", { name: "配当金サマリー" });
  await expect(summary.locator(".dividend-summary-total")).toContainText("兆");

  const layout = await summary.evaluate((element) => {
    const viewportWidth = document.documentElement.clientWidth;
    const rect = element.getBoundingClientRect();
    const escapingText = [...element.querySelectorAll("strong, small, dt, .dividend-summary-label")]
      .filter((node) => {
        const nodeRect = node.getBoundingClientRect();
        return nodeRect.left < -0.5 || nodeRect.right > viewportWidth + 0.5 || node.scrollWidth > nodeRect.width + 0.5;
      })
      .map((node) => node.textContent?.trim());

    return {
      height: rect.height,
      left: rect.left,
      right: rect.right,
      viewportWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      escapingText,
    };
  });

  expect(layout.left).toBeGreaterThanOrEqual(-0.5);
  expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 0.5);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.height).toBeLessThanOrEqual(120);
  expect(layout.escapingText).toEqual([]);
});


test("keeps all six mobile navigation targets within the iPhone viewport", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile navigation layout is verified on mobile projects.");
  await openDividendFixture(page);
  const bounds = await page.locator(".mobile-nav").evaluate((nav) => {
    const viewportWidth = document.documentElement.clientWidth;
    const buttons = [...nav.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return { count: buttons.length, left: Math.min(...buttons.map((rect) => rect.left)), right: Math.max(...buttons.map((rect) => rect.right)), viewportWidth };
  });
  expect(bounds.count).toBe(6);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
});
