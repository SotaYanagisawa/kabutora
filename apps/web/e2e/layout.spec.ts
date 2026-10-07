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

test("the home-screen status bar follows the app theme", async ({ page }) => {
  await installDemo(page);
  await page.goto("/");
  await expect(page.locator(".overview-page")).toBeVisible();
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "black-translucent");
  const themeColor = page.locator('meta[name="theme-color"]');
  await expect(themeColor).toHaveCount(1);
  await expect(themeColor).toHaveAttribute("content", "#f4f4f3");
  await openView(page, "設定");
  await page.locator(".view-cache.active").getByRole("button", { name: "ダークモード", exact: true }).click();
  await expect(themeColor).toHaveAttribute("content", "#000000");
});

test("content starts just below the Dynamic Island and scrolls up under it", async ({ page, isMobile }) => {
  test.skip(!isMobile, "The phone layout runs under the iOS status bar; desktop has its own header.");
  await installDemo(page);
  // Emulate an iPhone home-screen app: 59px top inset (status bar and Dynamic Island).
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => document.documentElement.style.setProperty("--safe-top", "59px")));
  await page.goto("/");
  await expect(page.locator(".overview-page")).toBeVisible();
  const strip = await page.locator(".market-overview-strip").boundingBox();
  expect(strip!.y).toBeGreaterThanOrEqual(50);
  expect(strip!.y).toBeLessThanOrEqual(53);
  // Scrolled, the top edge shows page content rather than a fixed band.
  await page.evaluate(() => window.scrollTo(0, 300));
  const covered = await page.evaluate(() => {
    let node = document.elementFromPoint(innerWidth / 2, 20) as HTMLElement | null;
    while (node && !["fixed", "sticky"].includes(getComputedStyle(node).position)) node = node.parentElement;
    return node?.className ?? null;
  });
  expect(covered).toBeNull();
});
