import { expect, test, type Page } from "./strict-fixture";
import { mockMarket } from "./market-fixture";
import { resolve as resolvePath } from "node:path";

const generatedAt = "2026-08-31T12:00:00.000Z";

async function setupPage(page: Page) {
  await page.route("**/api/local/bootstrap", (route) => route.fulfill({
    path: resolvePath(process.cwd(), "apps/web/data/demo-seed.json"),
    contentType: "application/json",
  }));
  await mockMarket(page, { generatedAt });

  await page.goto("/");
  const toolbar = page.locator(".daily-performance-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 20_000 });
}

async function getMeasurements(page: Page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector(".daily-performance-toolbar") as HTMLElement;
    const dailyRange = document.querySelector(".daily-range") as HTMLElement;
    const rangePresets = dailyRange?.querySelector(".chart-range-presets") as HTMLElement;
    const dateTrigger = dailyRange?.querySelector(".date-range-trigger") as HTMLElement;
    const metricToggle = toolbar?.querySelector(".daily-metric-toggle") as HTMLElement;

    const presetButtons = Array.from(rangePresets?.querySelectorAll("button") ?? []) as HTMLButtonElement[];
    const metricButtons = Array.from(metricToggle?.querySelectorAll("button") ?? []) as HTMLButtonElement[];

    const toolbarRect = toolbar.getBoundingClientRect();
    const rangePresetsRect = rangePresets.getBoundingClientRect();
    const dateTriggerRect = dateTrigger.getBoundingClientRect();
    const metricToggleRect = metricToggle.getBoundingClientRect();

    const gapPresetsToCalendar = dateTriggerRect.left - rangePresetsRect.right;
    const gapCalendarToMetric = metricToggleRect.left - dateTriggerRect.right;

    return {
      viewportWidth: window.innerWidth,
      toolbarRect,
      rangePresetsRect,
      dateTriggerRect,
      metricToggleRect,
      gapPresetsToCalendar,
      gapCalendarToMetric,
      presetButtonHeights: presetButtons.map((b) => b.getBoundingClientRect().height),
      metricButtonHeights: metricButtons.map((b) => b.getBoundingClientRect().height),
      rangePresetsComputed: {
        height: window.getComputedStyle(rangePresets).height,
        borderRadius: window.getComputedStyle(rangePresets).borderRadius,
        backgroundColor: window.getComputedStyle(rangePresets).backgroundColor,
        padding: window.getComputedStyle(rangePresets).padding,
      },
      metricToggleComputed: {
        height: window.getComputedStyle(metricToggle).height,
        borderRadius: window.getComputedStyle(metricToggle).borderRadius,
        backgroundColor: window.getComputedStyle(metricToggle).backgroundColor,
        padding: window.getComputedStyle(metricToggle).padding,
      },
      dateTriggerComputed: {
        height: window.getComputedStyle(dateTrigger).height,
        width: window.getComputedStyle(dateTrigger).width,
        borderRadius: window.getComputedStyle(dateTrigger).borderRadius,
        backgroundColor: window.getComputedStyle(dateTrigger).backgroundColor,
      },
      presetButtonComputed: presetButtons.map((b) => ({
        height: window.getComputedStyle(b).height,
        fontSize: window.getComputedStyle(b).fontSize,
        fontWeight: window.getComputedStyle(b).fontWeight,
        borderRadius: window.getComputedStyle(b).borderRadius,
      })),
      metricButtonComputed: metricButtons.map((b) => ({
        height: window.getComputedStyle(b).height,
        fontSize: window.getComputedStyle(b).fontSize,
        fontWeight: window.getComputedStyle(b).fontWeight,
        borderRadius: window.getComputedStyle(b).borderRadius,
      })),
      fitsInsideToolbar: (
        metricToggleRect.right <= toolbarRect.right + 1 &&
        rangePresetsRect.left >= toolbarRect.left - 1
      ),
    };
  });
}

test("chart filter row has consistent button sizes, margins, and spacing on mobile", async ({ page }) => {
  await setupPage(page);
  const measurements = await getMeasurements(page);

  // Outer heights match 34px
  expect(measurements.rangePresetsRect.height).toBeCloseTo(34, 1);
  expect(measurements.dateTriggerRect.height).toBeCloseTo(34, 1);
  expect(measurements.metricToggleRect.height).toBeCloseTo(34, 1);

  // Background and border-radius match
  expect(measurements.rangePresetsComputed.backgroundColor).toBe(measurements.metricToggleComputed.backgroundColor);
  expect(measurements.rangePresetsComputed.borderRadius).toBe(measurements.metricToggleComputed.borderRadius);
  expect(measurements.dateTriggerComputed.borderRadius).toBe(measurements.rangePresetsComputed.borderRadius);

  // Button heights match 28px
  for (const h of measurements.presetButtonHeights) {
    expect(h).toBeCloseTo(28, 1);
  }
  for (const h of measurements.metricButtonHeights) {
    expect(h).toBeCloseTo(28, 1);
  }

  // Button styles match
  for (const b of measurements.metricButtonComputed) {
    expect(b.fontWeight).toBe("700");
    expect(b.borderRadius).toBe("6px");
    expect(b.fontSize).toBe(measurements.presetButtonComputed[0].fontSize);
  }

  // Gaps are consistent
  expect(Math.abs(measurements.gapPresetsToCalendar - measurements.gapCalendarToMetric)).toBeLessThanOrEqual(1.5);
  expect(measurements.fitsInsideToolbar).toBe(true);
});
test("chart filter row has consistent button sizes, margins, and spacing on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupPage(page);
  const measurements = await getMeasurements(page);

  // Outer heights match 34px
  expect(measurements.rangePresetsRect.height).toBeCloseTo(34, 1);
  expect(measurements.dateTriggerRect.height).toBeCloseTo(34, 1);
  expect(measurements.metricToggleRect.height).toBeCloseTo(34, 1);

  // Background and border-radius match (9px on desktop)
  expect(measurements.rangePresetsComputed.backgroundColor).toBe(measurements.metricToggleComputed.backgroundColor);
  expect(measurements.rangePresetsComputed.borderRadius).toBe("9px");
  expect(measurements.metricToggleComputed.borderRadius).toBe("9px");
  expect(measurements.dateTriggerComputed.borderRadius).toBe("9px");

  // Button heights match 28px
  for (const h of measurements.presetButtonHeights) {
    expect(h).toBeCloseTo(28, 1);
  }
  for (const h of measurements.metricButtonHeights) {
    expect(h).toBeCloseTo(28, 1);
  }

  // Active button is 750, inactive buttons are 700 in both controls
  expect(measurements.presetButtonComputed[5].fontWeight).toBe("750"); // ALL is active default
  expect(measurements.presetButtonComputed[0].fontWeight).toBe("700"); // 1D is inactive
  expect(measurements.metricButtonComputed[0].fontWeight).toBe("750"); // 評価額 is active default
  expect(measurements.metricButtonComputed[1].fontWeight).toBe("700"); // 配当込み is inactive

  for (const b of measurements.metricButtonComputed) {
    expect(b.borderRadius).toBe("6px");
    expect(b.fontSize).toBe("12px");
  }
  for (const b of measurements.presetButtonComputed) {
    expect(b.borderRadius).toBe("6px");
    expect(b.fontSize).toBe("12px");
  }

  expect(measurements.fitsInsideToolbar).toBe(true);
});

test("chart filter row does not overflow on narrow mobile 360px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 667 });
  await setupPage(page);
  const measurements = await getMeasurements(page);

  expect(measurements.rangePresetsRect.height).toBeCloseTo(34, 1);
  expect(measurements.dateTriggerRect.height).toBeCloseTo(34, 1);
  expect(measurements.metricToggleRect.height).toBeCloseTo(34, 1);
  expect(measurements.fitsInsideToolbar).toBe(true);
});

test("switching chart range filters persists reliably without reverting", async ({ page }) => {
  await setupPage(page);

  const presets = page.locator(".daily-range .chart-range-presets button");
  const button3M = presets.filter({ hasText: "3M" });
  const buttonYtd = presets.filter({ hasText: "YTD" });
  const button1M = presets.filter({ hasText: "1M" });

  // Switch to 3M
  await button3M.click();
  await expect(button3M).toHaveClass(/active/);

  // Switch to YTD
  await buttonYtd.click();
  await expect(buttonYtd).toHaveClass(/active/);
  await expect(button3M).not.toHaveClass(/active/);

  // Wait beyond the 1000ms preferences debounce to verify it does not revert back to 3M
  await page.waitForTimeout(1500);
  await expect(buttonYtd).toHaveClass(/active/);
  await expect(button3M).not.toHaveClass(/active/);

  // Switch to 1M
  await button1M.click();
  await expect(button1M).toHaveClass(/active/);
  await expect(buttonYtd).not.toHaveClass(/active/);

  // Wait again beyond debounce
  await page.waitForTimeout(1500);
  await expect(button1M).toHaveClass(/active/);
  await expect(buttonYtd).not.toHaveClass(/active/);
});
