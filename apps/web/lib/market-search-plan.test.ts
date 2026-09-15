import { describe, expect, it } from "vitest";
import { searchProviderPlan } from "./market-search-plan";

describe("market search provider routing", () => {
  it("does not fan exact Japanese codes out to the global provider", () => {
    expect(searchProviderPlan("7203")).toBe("japan");
    expect(searchProviderPlan("130A")).toBe("japan");
  });

  it("routes Latin tickers globally and Japanese names through a bounded race", () => {
    expect(searchProviderPlan("AAPL")).toBe("global");
    expect(searchProviderPlan("トヨタ自動車")).toBe("both");
  });
});
