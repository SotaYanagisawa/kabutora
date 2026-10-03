import { test as base, expect } from "@playwright/test";
import { mockMarket } from "./market-fixture";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const test = base.extend<{ applicationErrors: string[] }>({
  applicationErrors: [async ({ page, baseURL }, use, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`unhandled: ${error.message}`));
    page.on("crash", () => errors.push("page crashed"));
    page.on("console", (item) => { if (item.type() === "error") errors.push(`console: ${item.text()}`); });
    page.on("response", (response) => {
      if (/\/api\/|\/_next\//u.test(response.url()) && response.status() >= 400) errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
    });
    page.on("requestfailed", (request) => {
      // Aborting superseded reads is part of the request protocol; all other
      // transport failures fail the test, including Worker/chunk loads.
      const reason = request.failure()?.errorText ?? "failed";
      if (!/abort|cancel/iu.test(reason) && /\/api\/|\/_next\//u.test(request.url())) errors.push(`request failed: ${new URL(request.url()).pathname}: ${reason}`);
    });
    // Default: an empty market. Specs register richer fixtures after this (later routes win).
    await mockMarket(page, {});
    await use(errors);
    const backend = JSON.parse(readFileSync(join(tmpdir(), `kabutora-test-backend-${new URL(baseURL!).port}.json`), "utf8"));
    expect(backend.failed, backend.message || "Backend process failed").toBe(false);
    if (!page.isClosed()) {
      await expect(page.locator(".chart-recovery, .client-recovery, .error-recovery")).toHaveCount(0);
      await expect(page.getByText(/CLIENT-[A-F0-9]{8}/u)).toHaveCount(0);
    }
    // WebKit's Firestore emulator can emit a late authorization error from a
    // terminated Listen channel after the deliberate offline/resume test has
    // already verified a successful trusted-tab replay. Keep this narrow and
    // test-specific; every other browser, request, and application failure is
    // still a release-gate failure.
    const toleratedResumeListener = (error: string) => testInfo.title.includes("two trusted devices")
      && (error.includes("google.firestore.v1.Firestore/Listen/channel?") || error.includes("/documents:batchGet?key=demo-emulator-key"))
      && error.endsWith("due to access control checks.");
    expect(errors.filter((error) => !toleratedResumeListener(error)), "Unexpected browser or application failures").toEqual([]);
  }, { auto: true }],
});
export { expect };
export type { Page } from "@playwright/test";
