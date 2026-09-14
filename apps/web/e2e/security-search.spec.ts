import { expect, test, type Page } from "./strict-fixture";
import { resolve as resolvePath } from "node:path";

type SearchResult = {
  id: string;
  displaySymbol: string;
  name: string;
  assetType: "stock";
  country: "US";
  exchangeMic: "XNAS";
  exchangeLabel: "NASDAQ";
  currency: "USD";
  providerSymbols: { yahoo: string };
};

const remoteResult = (symbol: string, name: string): SearchResult => ({
  id: `sec-test-${symbol.toLowerCase()}`,
  displaySymbol: symbol,
  name,
  assetType: "stock",
  country: "US",
  exchangeMic: "XNAS",
  exchangeLabel: "NASDAQ",
  currency: "USD",
  providerSymbols: { yahoo: symbol },
});

const largeWatchlistFixture = () => Array.from({ length: 100 }, (_, index) => ({
  id: `sec-fixture-${index}`,
  displaySymbol: `T${String(index).padStart(3, "0")}`,
  name: `Fixture Security ${index}`,
  assetType: "stock" as const,
  country: "US" as const,
  exchangeMic: "XNAS" as const,
  currency: "USD" as const,
  providerSymbols: { yahoo: `T${String(index).padStart(3, "0")}` },
}));

async function waitForApp(page: Page) {
  const generatedAt = new Date().toISOString();
  await page.route("**/api/local/bootstrap", (route) => route.fulfill({
    path: resolvePath(process.cwd(), "apps/web/data/demo-seed.json"),
    contentType: "application/json",
  }));
  await page.route("**/api/market/quotes", (route) => route.fulfill({
    json: {
      generatedAt,
      marketSessions: [],
      quotes: [],
      intraday: [],
      failures: [],
      coverage: { requested: 0, returned: 0, fresh: 0, stale: 0, suspect: 0 },
    },
  }));
  await page.route("**/api/market/history", (route) => route.fulfill({
    json: {
      generatedAt,
      marketSessions: [],
      bars: [],
      corporateActions: [],
      inceptionDates: {},
      failures: [],
      coverage: { requested: 0, returned: 0 },
    },
  }));
  await page.route("**/api/market/benchmarks**", (route) => route.fulfill({
    json: { generatedAt, marketSessions: [], benchmarks: [], failures: [] },
  }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^(検索|銘柄検索)$/u })).toBeVisible({ timeout: 20_000 });
}

async function openWatchlistSearch(page: Page) {
  await page.getByRole("button", { name: /^(検索|銘柄検索)$/u }).click();
  await page.getByRole("button", { name: "銘柄を検索" }).click();
  return page.getByPlaceholder("銘柄名・ティッカー・投信を検索", { exact: true });
}

test("watchlist search keeps typing urgent, IME-aware, and debounced", async ({ page }) => {
  const queries: string[] = [];
  await page.route("**/api/market/search", async (route) => {
    const body = route.request().postDataJSON() as { q: string };
    queries.push(body.q);
    await route.fulfill({ json: { results: [] } });
  });
  await waitForApp(page);
  const input = await openWatchlistSearch(page);

  await input.pressSequentially("トヨタ", { delay: 20 });
  await expect(input).toHaveValue("トヨタ");
  const dialog = page.getByRole("dialog", { name: "銘柄検索" });
  await expect(dialog.getByText("トヨタ自動車", { exact: true })).toBeVisible();
  await page.waitForTimeout(180);
  expect(queries).toEqual([]);
  await expect.poll(() => [...queries]).toEqual(["トヨタ"]);

  await page.getByRole("button", { name: "検索をクリア" }).click();
  await input.dispatchEvent("compositionstart");
  await input.fill("エヌビディア");
  await expect(input).toHaveValue("エヌビディア");
  await page.waitForTimeout(320);
  expect(queries).toEqual(["トヨタ"]);
  await input.dispatchEvent("compositionend", { data: "エヌビディア" });
  await expect(dialog.getByText("NVIDIA Corporation", { exact: true })).toBeVisible();
  await expect.poll(() => [...queries]).toEqual(["トヨタ", "エヌビディア"]);
});

test("late remote responses cannot replace the current query", async ({ page }) => {
  await page.route("**/api/market/search", async (route) => {
    const body = route.request().postDataJSON() as { q: string };
    if (body.q === "SLOWTEST") {
      await new Promise((resolve) => setTimeout(resolve, 650));
      await route.fulfill({ json: { results: [remoteResult("SLOW", "Stale Slow Result")] } });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    await route.fulfill({ json: { results: [remoteResult("FAST", "Current Fast Result")] } });
  });
  await waitForApp(page);
  const input = await openWatchlistSearch(page);

  await input.fill("SLOWTEST");
  await page.waitForTimeout(300);
  await input.fill("FASTTEST");
  const dialog = page.getByRole("dialog", { name: "銘柄検索" });
  await expect(dialog.getByText("Current Fast Result", { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(dialog.getByText("Stale Slow Result", { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue("FASTTEST");
});

test("watchlist controls and covered content remain stable", async ({ page }) => {
  const watchlist = largeWatchlistFixture();
  await page.addInitScript((fixture) => {
    localStorage.setItem("kabutora-watchlist-v1", JSON.stringify(fixture));
  }, watchlist);
  await page.route("**/api/market/search", (route) => route.fulfill({ json: { results: [] } }));
  await waitForApp(page);
  await page.getByRole("button", { name: /^(検索|銘柄検索)$/u }).click();
  const rows = page.locator(".watchlist-holdings-table tbody tr");
  await expect(rows).toHaveCount(100);
  await page.getByRole("button", { name: "銘柄を検索" }).click();
  const input = page.getByPlaceholder("銘柄名・ティッカー・投信を検索", { exact: true });
  await expect(page.locator(".watchlist-view-content")).toHaveCSS("visibility", "hidden");
  await input.pressSequentially("AAPL", { delay: 10 });
  await expect(input).toHaveValue("AAPL");
  await expect(rows).toHaveCount(100);

  const appleToggle = page.getByRole("button", { name: "Apple Inc.を追加" });
  await expect(appleToggle).toBeVisible();
  await appleToggle.click();
  await expect(page.getByRole("button", { name: "Apple Inc.を削除" })).toBeVisible();
  await input.press("Escape");
  await expect(input).toHaveValue("");
  await input.press("Escape");
  await expect(page.getByRole("dialog", { name: "銘柄検索" })).toHaveCount(0);
  await expect(rows).toHaveCount(101);
});

test("large-watchlist typing and local-result paint stay within the input budget", async ({ page }, testInfo) => {
  await page.addInitScript((fixture) => {
    localStorage.setItem("kabutora-watchlist-v1", JSON.stringify(fixture));
  }, largeWatchlistFixture());
  await page.route("**/api/market/search", (route) => route.fulfill({ json: { results: [] } }));
  await waitForApp(page);
  const input = await openWatchlistSearch(page);

  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>("input[placeholder='銘柄名・ティッカー・投信を検索']");
    if (!field) throw new Error("search_input_missing");
    const state = {
      inputPaintMs: [] as number[],
      longTasksMs: [] as number[],
      longTaskSupported: PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false,
    };
    (window as unknown as { __kabutoraSearchProfile: typeof state }).__kabutoraSearchProfile = state;
    field.addEventListener("input", () => {
      const startedAt = performance.now();
      requestAnimationFrame(() => {
        state.inputPaintMs.push(performance.now() - startedAt);
      });
    });
    if (state.longTaskSupported) {
      new PerformanceObserver((entries) => {
        state.longTasksMs.push(...entries.getEntries().map((entry) => entry.duration));
      }).observe({ type: "longtask", buffered: false });
    }
  });

  const burst = "AAPLトヨタNVDAアップル";
  await input.pressSequentially(burst);
  await expect(input).toHaveValue(burst);
  for (let index = 0; index < burst.length; index += 1) await input.press("Backspace");
  await expect(input).toHaveValue("");

  const localStartedAt = Date.now();
  await input.pressSequentially("トヨタ");
  await expect(page.getByRole("dialog", { name: "銘柄検索" }).getByText("トヨタ自動車", { exact: true })).toBeVisible();
  const localPaintMs = Date.now() - localStartedAt;
  await page.waitForTimeout(50);

  const profile = await page.evaluate(() => (
    window as unknown as {
      __kabutoraSearchProfile: {
        inputPaintMs: number[];
        longTasksMs: number[];
        longTaskSupported: boolean;
      };
    }
  ).__kabutoraSearchProfile);
  const sorted = [...profile.inputPaintMs].sort((left, right) => left - right);
  const p95InputPaintMs = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  const maxInputPaintMs = sorted.at(-1) ?? 0;
  const maxLongTaskMs = profile.longTasksMs.length ? Math.max(...profile.longTasksMs) : 0;
  console.log(JSON.stringify({
    project: testInfo.project.name,
    samples: sorted.length,
    p95InputPaintMs: Number(p95InputPaintMs.toFixed(1)),
    maxInputPaintMs: Number(maxInputPaintMs.toFixed(1)),
    localPaintMs,
    longTaskSupported: profile.longTaskSupported,
    maxLongTaskMs: Number(maxLongTaskMs.toFixed(1)),
  }));

  expect(p95InputPaintMs).toBeLessThanOrEqual(50);
  expect(maxInputPaintMs).toBeLessThanOrEqual(100);
  expect(localPaintMs).toBeLessThanOrEqual(100);
  if (profile.longTaskSupported) expect(maxLongTaskMs).toBeLessThanOrEqual(50);
});

test("trade-entry search shares IME, keyboard, clear, and selection behavior", async ({ page }) => {
  const queries: string[] = [];
  await page.route("**/api/market/search", async (route) => {
    const body = route.request().postDataJSON() as { q: string };
    queries.push(body.q);
    await route.fulfill({ json: { results: [] } });
  });
  await waitForApp(page);
  await page.getByRole("button", { name: /^取引(?:履歴)?$/u }).click();
  await page.getByRole("button", { name: "取引を追加" }).click();
  const input = page.getByPlaceholder("名前・コード・ティッカー", { exact: true });

  await input.dispatchEvent("compositionstart");
  await input.fill("エヌビディア");
  await page.waitForTimeout(320);
  expect(queries).toEqual([]);
  await input.dispatchEvent("compositionend", { data: "エヌビディア" });
  await expect(page.locator(".security-suggestions").getByText("NVIDIA Corporation", { exact: true })).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.getByText("選択中", { exact: true })).toBeVisible();
  await page.getByLabel("数量", { exact: true }).fill("1");
  await page.getByLabel("価格（USD）", { exact: true }).fill("100");
  await expect(page.getByRole("button", { name: /端末に保存|保存して同期/ })).toBeEnabled();

  await input.fill("AAPL");
  await expect(page.getByRole("button", { name: "検索をクリア" })).toBeVisible();
  await input.press("Escape");
  await expect(input).toHaveValue("");
});
