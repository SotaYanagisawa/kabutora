import { defineConfig } from "@playwright/test";

const mobileViewport = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
};

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
  },
  webServer: {
    command: "node scripts/test-web-server.mjs 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 120_000,
  },
  projects: [
    { name: "desktop-chromium", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } }, testIgnore: "**/chart-filter-row.spec.ts" },
    { name: "desktop-webkit", use: { browserName: "webkit", viewport: { width: 1440, height: 1000 } }, testIgnore: "**/chart-filter-row.spec.ts" },
    {
      name: "mobile-chromium",
      use: { ...mobileViewport, browserName: "chromium" },
    },
    {
      name: "mobile-webkit",
      use: { ...mobileViewport, browserName: "webkit" },
    },
  ],
});
