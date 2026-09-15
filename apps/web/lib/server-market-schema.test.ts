import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../migrations/0001_market_snapshots.sql", import.meta.url), "utf8");
const distributionMigration = readFileSync(new URL("../migrations/0002_market_distributions.sql", import.meta.url), "utf8");
const distributionCoverageMigration = readFileSync(new URL("../migrations/0003_market_distribution_coverage.sql", import.meta.url), "utf8");
const ptsMigration = readFileSync(new URL("../migrations/0005_japannext_pts_frames.sql", import.meta.url), "utf8");
const refreshRoute = readFileSync(new URL("../app/api/market/refresh/route.ts", import.meta.url), "utf8");

describe("server market privacy schema", () => {
  it("stores public security and market fields without portfolio-private columns", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS market_securities");
    expect(migration).toContain("security_id TEXT PRIMARY KEY");
    expect(migration).not.toMatch(/\b(transaction|account_id|portfolio_id|quantity|cost_basis|purchase_price|broker|holding|cash_balance|user_id|uid|email|owner_id|display_name)\b/iu);
    expect(distributionMigration).toContain("CREATE TABLE IF NOT EXISTS market_distributions");
    expect(distributionMigration).not.toMatch(/\b(transaction|account_id|portfolio_id|eligible_quantity|cost_basis|purchase_price|broker|holding|cash_balance|user_id|uid|email|owner_id|display_name)\b/iu);
    expect(distributionCoverageMigration).toContain("CREATE TABLE IF NOT EXISTS market_distribution_coverage");
    expect(distributionCoverageMigration).not.toMatch(/\b(transaction|account_id|portfolio_id|eligible_quantity|cost_basis|purchase_price|broker|holding|cash_balance|user_id|uid|email|owner_id|display_name)\b/iu);
    expect(ptsMigration).toContain("CREATE TABLE IF NOT EXISTS market_pts_frames");
    expect(ptsMigration).not.toMatch(/\b(transaction|account_id|portfolio_id|quantity|cost_basis|purchase_price|broker|holding|cash_balance|user_id|uid|email|owner_id|display_name)\b/iu);
  });

  it("accepts only public symbol identifiers for manual refresh", () => {
    expect(refreshRoute).toContain('key !== "securityIds"');
    expect(refreshRoute).toContain("record.securityIds.length > 200");
    expect(refreshRoute).not.toMatch(/\b(quantity|transaction|portfolio|broker|holding|accountId|email)\b/u);
  });
});
