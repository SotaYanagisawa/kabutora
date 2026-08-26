import { describe, expect, it } from "vitest";
import { companyDisplayName, companyLegalName } from "./company-name";

describe("companyDisplayName", () => {
  it("uses a provider alias without a company-specific hardcoded rule", () => {
    const company = {
      name: "Space Exploration Technologies Corp.",
      shortName: "SpaceX",
      longName: "Space Exploration Technologies Corp.",
      country: "US",
    };

    expect(companyDisplayName(company)).toBe("SpaceX");
    expect(companyLegalName(company)).toBe("Space Exploration Technologies Corp.");
  });

  it("prefers a verified knowledge-graph brand over a verbose provider short name", () => {
    expect(companyDisplayName({
      name: "Space Exploration Technologies Corp.",
      brandName: "SpaceX",
      shortName: "Space Exploration Technologies",
      longName: "Space Exploration Technologies Corp.",
      country: "US",
    })).toBe("SpaceX");
  });

  it("removes generic legal suffixes when no provider alias exists", () => {
    expect(companyDisplayName({
      name: "Taiwan Semiconductor Manufacturing Company Limited",
      country: "US",
    })).toBe("Taiwan Semiconductor Manufacturing");
  });

  it("does not alter Japanese security names", () => {
    expect(companyDisplayName({ name: "トヨタ自動車(株)", exchangeMic: "XTKS" })).toBe("トヨタ自動車(株)");
  });
});
