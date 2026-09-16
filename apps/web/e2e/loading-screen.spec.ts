import { test, expect } from "./strict-fixture";

test("startup loading screen centers logo and positions app name and indicators below", async ({ page }) => {
  await page.route("**/api/local/bootstrap", async () => {
    // Keep pending to inspect the startup loading screen
  });
  await page.goto("/");
  const screen = page.locator(".app-loading-screen");
  await expect(screen).toBeVisible();

  const logo = page.locator(".app-loading-logo");
  const brand = page.locator(".app-loading-brand");
  const copy = page.locator(".app-loading-copy");

  await expect(logo).toBeVisible();
  await expect(brand).toBeVisible();
  await expect(copy).toBeVisible();

  const viewport = page.viewportSize()!;
  const logoBox = (await logo.boundingBox())!;
  const brandBox = (await brand.boundingBox())!;
  const copyBox = (await copy.boundingBox())!;

  const logoCenterX = logoBox.x + logoBox.width / 2;
  const logoCenterY = logoBox.y + logoBox.height / 2;

  // App logo must be centered in the screen
  expect(Math.abs(logoCenterX - viewport.width / 2)).toBeLessThan(1.5);
  expect(Math.abs(logoCenterY - viewport.height / 2)).toBeLessThan(1.5);

  // App brand text must be below the logo
  expect(brandBox.y).toBeGreaterThanOrEqual(logoBox.y + logoBox.height);

  // Indicator copy must be below the app brand text
  expect(copyBox.y).toBeGreaterThanOrEqual(brandBox.y + brandBox.height);

  // Text font sizes must be unchanged
  const copyP = page.locator(".app-loading-copy p");
  const copySmall = page.locator(".app-loading-copy small");
  const copyPFontSize = await copyP.evaluate((el) => window.getComputedStyle(el).fontSize);
  const copySmallFontSize = await copySmall.evaluate((el) => window.getComputedStyle(el).fontSize);
  expect(copyPFontSize).toBe("13px");
  expect(copySmallFontSize).toBe("9.5px");
});
