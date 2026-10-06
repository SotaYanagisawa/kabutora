import { expect, test } from "./strict-fixture";
import { installDemo, openView } from "./demo-portfolio";

test("keeps all six mobile navigation targets within the viewport", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile navigation layout is verified on mobile projects.");
  await installDemo(page);
  await page.goto("/");
  await expect(page.locator(".overview-page")).toBeVisible();
  const bounds = await page.locator(".mobile-nav").evaluate((nav) => {
    const viewportWidth = document.documentElement.clientWidth;
    const buttons = [...nav.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
    return { count: buttons.length, left: Math.min(...buttons.map((rect) => rect.left)), right: Math.max(...buttons.map((rect) => rect.right)), viewportWidth };
  });
  expect(bounds.count).toBe(6);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
});

test("chart ranges switch and persist, and every view renders without page overflow", async ({ page }) => {
  await installDemo(page);
  await page.goto("/");
  const presets = page.locator(".daily-range .chart-range-presets");
  for (const range of ["1W", "1M", "3M", "YTD", "ALL", "1D"]) {
    await presets.getByRole("button", { name: range, exact: true }).click();
    await expect(presets.getByRole("button", { name: range, exact: true })).toHaveClass(/active/);
  }
  await page.reload();
  await expect(page.locator(".daily-range .chart-range-presets").getByRole("button", { name: "1D", exact: true })).toHaveClass(/active/);
  for (const view of ["取引", "検索", "配当", "通知", "設定", "一覧"] as const) {
    await openView(page, view);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
});
