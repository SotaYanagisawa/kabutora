import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "apps/web/e2e/**", "apps/web/cloud-e2e/**"],
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/web"),
    },
  },
});
