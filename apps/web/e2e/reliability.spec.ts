import { test, expect } from "./strict-fixture";
import { installSyntheticPortfolio, syntheticPortfolio } from "./reliability-fixture";

test("older Safari without AbortSignal.timeout still starts and loads prices", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  });
  let quoteRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/market/quotes") quoteRequests += 1;
  });
  await installSyntheticPortfolio(page, syntheticPortfolio(4, 20, 200));
  await page.goto("/");
  await expect(page.locator("main.workspace")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => quoteRequests).toBeGreaterThan(0);
  await expect(page.locator(".market-health")).not.toContainText("取得中");
});

test("quote requests settle on startup and do not loop repeatedly", async ({ page }) => {
  let quoteRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/market/quotes") quoteRequests += 1;
  });
  await installSyntheticPortfolio(page, syntheticPortfolio(4, 20, 200));
  await page.goto("/");
  await expect(page.locator("main.workspace")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => quoteRequests).toBeGreaterThan(0);
  await expect(page.locator(".market-health")).not.toContainText("取得中");

  await page.waitForTimeout(4000);
  expect(quoteRequests).toBeLessThanOrEqual(3);
});

test("fresh prices update the selected portfolio without requiring a filter round-trip", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "The manual refresh control is desktop-only; mobile refresh uses the existing pull gesture coverage.");
  const fixture = await installSyntheticPortfolio(page, syntheticPortfolio(8, 160, 240));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
  const value = page.locator(".daily-stat-item.primary .daily-stat-val");
  const before = await value.innerText();

  fixture.generatedAt = new Date().toISOString();
  fixture.quotes = fixture.quotes.map((quote) => quote.securityId === "sec-fx-usdjpy"
    ? quote
    : { ...quote, price: String(Number(quote.price) * 2), fetchedAt: fixture.generatedAt, marketTimestamp: fixture.generatedAt });
  await page.getByRole("button", { name: "市場データを更新", exact: true }).click();
  await expect.poll(() => value.innerText(), { timeout: 20_000 }).not.toBe(before);
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
});

test("100 portfolio filter changes settle within two jobs and keep input-to-paint below 100 ms", async ({ page, browserName }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await installSyntheticPortfolio(page);
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => Number(await workspace.getAttribute("data-history-bar-copies")), { timeout: 30_000 }).toBeGreaterThanOrEqual(fixture.bars.length);
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
  const copiesBefore = Number(await workspace.getAttribute("data-history-bar-copies"));
  const profiler = process.env.KABUTORA_PROFILE && browserName === "chromium" ? await page.context().newCDPSession(page) : null;
  if (profiler) { await profiler.send("Profiler.enable"); await profiler.send("Profiler.start"); }
  const durations = await page.evaluate(async () => {
    const values = ["JP", "US", "ALL", "FUNDS_INDEXES"];
    const measurements: number[] = [];
    for (let index = 0; index < 100; index++) {
      const filter = [...document.querySelectorAll<HTMLSelectElement>('[aria-label^="資産区分"]')].find((element) => element.getClientRects().length > 0)!;
      const start = performance.now();
      filter.value = values[index % values.length];
      filter.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      measurements.push(performance.now() - start);
    }
    return measurements;
  });
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
  expect(Number(await workspace.getAttribute("data-history-max-pending"))).toBeLessThanOrEqual(2);
  expect(Number(await workspace.getAttribute("data-history-bar-copies"))).toBe(copiesBefore);
  const p95 = [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * .95) - 1];
  if (profiler) {
    const { profile } = await profiler.send("Profiler.stop");
    await testInfo.attach("cpu-profile", { body: JSON.stringify(profile), contentType: "application/json" });
    const counts = new Map<number, number>();
    for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    console.log(JSON.stringify(profile.nodes.map((node) => ({ name: node.callFrame.functionName, file: node.callFrame.url.slice(-150), line: node.callFrame.lineNumber, samples: counts.get(node.id) ?? 0 })).sort((a, b) => b.samples - a.samples).slice(0, 20)));
  }
  await testInfo.attach("filter-performance", { body: JSON.stringify({ transactions: 1000, bars: fixture.bars.length, changes: 100, p95, max: Math.max(...durations), maxPending: await workspace.getAttribute("data-history-max-pending") }), contentType: "application/json" });
  console.log(JSON.stringify({ project: testInfo.project.name, filterChanges: 100, bars: fixture.bars.length, p95 }));
  expect(p95).toBeLessThan(100);
});

test("idle-preloaded main menu switches paint within 100 ms", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await installSyntheticPortfolio(page, syntheticPortfolio(12, 240, 400));
  await page.route("**/api/market/distributions", (route) => route.fulfill({ json: { distributions: [], coverage: [], failures: [] } }));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(workspace).toHaveAttribute("data-navigation-views-preloaded", "true", { timeout: 20_000 });
  await expect(page.locator(".activity-page")).toHaveCount(1);
  await expect(page.locator(".watchlist-page-container")).toHaveCount(1);
  await expect(page.locator(".dividends-page")).toHaveCount(1);
  await expect(page.locator(".notification-page")).toHaveCount(1);
  await expect(page.locator(".settings-page-container")).toHaveCount(1);

  const durations = await page.evaluate(async () => {
    const visibleNav = [...document.querySelectorAll<HTMLElement>("nav")].find((nav) => nav.getClientRects().length > 0 && (nav.classList.contains("mobile-nav") || nav.classList.contains("desktop-nav")))!;
    const buttons = [...visibleNav.querySelectorAll<HTMLButtonElement>("button")];
    const measurements: number[] = [];
    for (let index = 0; index < 60; index++) {
      const start = performance.now();
      buttons[index % buttons.length].click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      measurements.push(performance.now() - start);
    }
    return measurements;
  });
  const p95 = [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * .95) - 1];
  await testInfo.attach("navigation-performance", { body: JSON.stringify({ changes: durations.length, p95, max: Math.max(...durations) }), contentType: "application/json" });
  console.log(JSON.stringify({ project: testInfo.project.name, menuChanges: durations.length, p95 }));
  expect(p95).toBeLessThan(100);
});

test("precomputed chart durations switch within 100 ms without additional market requests", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  let quoteRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/market/quotes") quoteRequests += 1;
  });
  await installSyntheticPortfolio(page, syntheticPortfolio(20, 1_000, 1_800));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
  const requestsBefore = quoteRequests;
  const durations = await page.evaluate(async () => {
    const labels = ["1D", "1W", "1M", "3M", "YTD", "ALL"];
    const measurements: number[] = [];
    for (let index = 0; index < 100; index++) {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".daily-range .chart-range-presets button")].find((item) => item.textContent?.trim() === labels[index % labels.length])!;
      const start = performance.now();
      button.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      measurements.push(performance.now() - start);
    }
    return measurements;
  });
  const p95 = [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * .95) - 1];
  await testInfo.attach("chart-range-performance", { body: JSON.stringify({ changes: durations.length, p95, max: Math.max(...durations), quoteRequests: quoteRequests - requestsBefore }), contentType: "application/json" });
  console.log(JSON.stringify({ project: testInfo.project.name, chartRangeChanges: durations.length, p95, quoteRequests: quoteRequests - requestsBefore }));
  expect(p95).toBeLessThan(100);
  expect(quoteRequests).toBe(requestsBefore);
});

test("touch-selected JP chart survives shorter US, empty histories, currencies and date ranges", async ({ page }) => {
  test.setTimeout(120_000);
  await installSyntheticPortfolio(page, syntheticPortfolio(10, 100, 200));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  const filter = page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  await expect(filter).toBeVisible({ timeout: 20_000 });
  await filter.selectOption("JP");
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
  await page.getByLabel("クリックしてチャートを拡大", { exact: true }).click();
  const chart = page.locator(".daily-chart.expanded svg").first();
  await expect(chart).toBeVisible();
  // The expanded chart remains mounted while the history and series change.
  for (const currency of ["JPY", "USD", "NATIVE"]) {
    await page.getByRole("combobox", { name: "表示通貨", exact: true }).selectOption(currency);
    await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
    for (const market of ["JP", "US", "FUNDS_INDEXES", "ALL"]) {
      if (await chart.isVisible() && await filter.inputValue() !== "FUNDS_INDEXES") {
        const box = await chart.boundingBox();
        if (box) {
          await chart.dispatchEvent("pointerdown", { pointerType: "touch", clientX: box.x + box.width - 12, clientY: box.y + box.height / 2, bubbles: true });
          await chart.dispatchEvent("pointerleave", { pointerType: "touch", bubbles: true });
          await expect(page.locator(".daily-chart.expanded .lightweight-chart-tooltip")).toBeVisible();
        }
      }
      await filter.selectOption(market);
      await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
      await expect(filter).toHaveValue(market);
      await expect(page.locator(".chart-recovery")).toHaveCount(0);
    }
  }
  await page.getByRole("combobox", { name: "証券会社で絞り込み", exact: true }).selectOption("合成証券1");
  await filter.selectOption("US");
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false");
  await page.getByRole("combobox", { name: "証券会社で絞り込み", exact: true }).selectOption("ALL");
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  for (const name of ["1W", "1M", "3M", "YTD", "ALL"]) await page.locator(".daily-range").getByRole("button", { name, exact: true }).click();
  await page.getByLabel("日付範囲を指定", { exact: true }).click();
  await expect(page.getByRole("dialog", { name: "表示期間を指定" })).toBeVisible();
  await page.getByRole("button", { name: "適用", exact: true }).click();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false");
});

test("larger synthetic portfolio remains responsive and settles superseded work", async ({ page }) => {
  test.setTimeout(120_000);
  await installSyntheticPortfolio(page, syntheticPortfolio(60, 5000, 1800));
  await page.goto("/");
  const filter = page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  await expect(filter).toBeVisible({ timeout: 30_000 });
  for (const value of ["US", "ALL", "JP", "FUNDS_INDEXES", "ALL"]) await filter.selectOption(value);
  await expect(page.locator("main.workspace")).toHaveAttribute("data-calculation-pending", "false", { timeout: 30_000 });
  expect(Number(await page.locator("main.workspace").getAttribute("data-history-max-pending"))).toBeLessThanOrEqual(2);
});

test("unsupported workers use the yielding fallback and missing FX remains explicitly unavailable", async ({ page }) => {
  const fixture = syntheticPortfolio(4, 100, 120);
  fixture.bars = fixture.bars.filter((bar) => bar.securityId !== "sec-fx-usdjpy");
  fixture.quotes = fixture.quotes.filter((quote) => quote.securityId !== "sec-fx-usdjpy");
  await page.addInitScript(() => Object.defineProperty(window, "Worker", { value: undefined }));
  await installSyntheticPortfolio(page, fixture);
  await page.route("**/api/market/benchmarks**", (route) => route.fulfill({ json: { benchmarks: [], failures: [] } }));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  const filter = page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  await expect(filter).toBeVisible({ timeout: 20_000 });
  for (const value of ["US", "JP", "ALL"]) await filter.selectOption(value);
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 20_000 });
  await expect(page.getByText("為替レートを確認できないため、換算合計は未確定です", { exact: true })).toBeVisible();
  expect(Number(await workspace.getAttribute("data-history-max-pending"))).toBeLessThanOrEqual(2);
  expect(Number(await workspace.getAttribute("data-history-bar-copies"))).toBe(0);
});

test("switching market filters and selecting JP and US stocks does not trigger quote storm or crash", async ({ page }) => {
  let quoteRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/market/quotes") quoteRequests += 1;
  });
  await installSyntheticPortfolio(page, syntheticPortfolio(6, 40, 200));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => quoteRequests).toBeGreaterThan(0);
  await expect(page.locator(".market-health")).not.toContainText("取得中");

  const initialRequests = quoteRequests;

  // 1. Switch market filters between JP and US
  const filter = page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  await expect(filter).toBeVisible();
  await filter.selectOption("JP");
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 15_000 });
  await filter.selectOption("US");
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 15_000 });
  await filter.selectOption("ALL");
  await expect(workspace).toHaveAttribute("data-calculation-pending", "false", { timeout: 15_000 });

  // Switching filters should NOT trigger any new quote requests
  expect(quoteRequests).toBe(initialRequests);

  // 2. Click a stock row to open security detail
  const rows = page.locator("tr.selectable");
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });
  await rows.first().click();

  // Detail view should open smoothly without triggering a quote request storm
  await expect(page.locator(".security-detail-page")).toBeVisible({ timeout: 10_000 });
  const backButton = page.locator(".detail-back-button");
  await expect(backButton).toBeVisible();
  await backButton.click();
  await expect(page.locator(".security-detail-page")).toHaveCount(0);

  // 3. Click second stock row (e.g. US stock if first was JP)
  if (await rows.count() > 1) {
    await rows.nth(1).click();
    await expect(page.locator(".security-detail-page")).toBeVisible({ timeout: 10_000 });
    await page.locator(".detail-back-button").click();
    await expect(page.locator(".security-detail-page")).toHaveCount(0);
  }

  // 4. Wait to ensure no delayed 1.5s infinite reload storm fires
  await page.waitForTimeout(3500);
  // Total quote requests must remain strictly bounded (no loops)
  expect(quoteRequests).toBeLessThanOrEqual(initialRequests + 1);
  await expect(page.locator(".market-health")).not.toContainText("取得中");
});

test("switching market filters synchronously retains performance metrics and keeps top strip unshifted", async ({ page }) => {
  await installSyntheticPortfolio(page, syntheticPortfolio(6, 40, 200));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".market-health")).not.toContainText("取得中");
  await expect(workspace).toHaveAttribute("data-market-views-preloaded", "true", { timeout: 20_000 });

  const totalValueVal = page.locator(".daily-stat-item.primary .daily-stat-val");
  await expect(totalValueVal).toBeVisible();
  const initialValueText = await totalValueVal.innerText();
  expect(initialValueText).not.toBe("—");
  expect(initialValueText).not.toBe("--");

  const filter = page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  await expect(filter).toBeVisible();

  // Ensure quotes and market tape have settled before measuring
  await expect(page.locator(".market-overview-strip")).toBeVisible();
  await page.waitForTimeout(500);

  const getSummaryTop = async () => {
    return page.evaluate(() => {
      const summary = document.querySelector(".daily-summary") as HTMLElement | null;
      return summary?.offsetTop ?? 0;
    });
  };

  const initialTop = await getSummaryTop();

  // Switch to JP
  await filter.selectOption("JP");
  expect(await workspace.getAttribute("data-calculation-pending")).toBe("false");
  const jpImmediateValue = await totalValueVal.innerText();
  expect(jpImmediateValue).not.toBe("—");
  expect(jpImmediateValue).not.toBe("--");
  expect(jpImmediateValue).not.toMatch(/^[¥$]0(?:\.00)?$/);
  await expect(page.locator(".overview-critical-alert")).toHaveCount(0);
  const jpTop = await getSummaryTop();
  expect(Math.abs(jpTop - initialTop)).toBeLessThan(15);

  // Switch to US
  await filter.selectOption("US");
  expect(await workspace.getAttribute("data-calculation-pending")).toBe("false");
  const usImmediateValue = await totalValueVal.innerText();
  expect(usImmediateValue).not.toBe("—");
  expect(usImmediateValue).not.toBe("--");
  expect(usImmediateValue).not.toMatch(/^[¥$]0(?:\.00)?$/);
  await expect(page.locator(".overview-critical-alert")).toHaveCount(0);
  const usTop = await getSummaryTop();
  expect(Math.abs(usTop - initialTop)).toBeLessThan(15);

  // Switch back to ALL
  await filter.selectOption("ALL");
  expect(await workspace.getAttribute("data-calculation-pending")).toBe("false");
  const allImmediateValue = await totalValueVal.innerText();
  expect(allImmediateValue).not.toBe("—");
  expect(allImmediateValue).not.toBe("--");
  expect(allImmediateValue).not.toMatch(/^[¥$]0(?:\.00)?$/);
  await expect(page.locator(".overview-critical-alert")).toHaveCount(0);
  const allTop = await getSummaryTop();
  expect(Math.abs(allTop - initialTop)).toBeLessThan(15);
});

test("stock filter option never automatically reverts to previous selection during background sync", async ({ page }) => {
  await installSyntheticPortfolio(page, syntheticPortfolio(6, 40, 200));
  await page.goto("/");
  const workspace = page.locator("main.workspace");
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".market-health")).not.toContainText("取得中");

  const filter = page.getByRole("combobox", { name: /資産区分(?:と国)?で絞り込み/u });
  await expect(filter).toBeVisible();

  // Select JP
  await filter.selectOption("JP");
  expect(await filter.inputValue()).toBe("JP");

  // Quickly switch to US before debounce finishes
  await page.waitForTimeout(400);
  await filter.selectOption("US");
  expect(await filter.inputValue()).toBe("US");

  // Wait beyond preference save debounce (1000ms) and cloud sync (2000ms)
  await page.waitForTimeout(2500);

  // Assert filter NEVER reverted to ALL or JP
  expect(await filter.inputValue()).toBe("US");

  // Chart should have points and not show empty-state
  const chart = page.locator(".daily-chart svg");
  await expect(chart).toBeVisible();
  await expect(page.locator(".daily-chart .empty-state")).toHaveCount(0);
});
