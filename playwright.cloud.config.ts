import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./apps/web/cloud-e2e",
  timeout: 60_000,
  use: { ...base.use, baseURL: "http://127.0.0.1:3002" },
  webServer: {
    command: "NEXT_PUBLIC_KABUTORA_MARKET_BACKEND=v2 NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION=enabled NEXT_PUBLIC_KABUTORA_EMULATORS=1 node scripts/test-web-server.mjs 3002",
    url: "http://127.0.0.1:3002", reuseExistingServer: false, timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
