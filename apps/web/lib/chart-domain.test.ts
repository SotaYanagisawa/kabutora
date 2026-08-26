import { describe, expect, it } from "vitest";
import { dynamicChartDomain } from "./chart-domain";

describe("dynamic chart domain", () => {
  it("includes every visible series without forcing a non-ALL chart to zero", () => {
    const domain = dynamicChartDomain([4_000_000, 4_100_000], [5_000_000, 0]);
    expect(domain[0]).toBeGreaterThan(3_000_000);
    expect(domain[0]).toBeLessThan(4_000_000);
    expect(domain[1]).toBeGreaterThan(5_000_000);
  });

  it("starts ALL charts at zero", () => {
    expect(dynamicChartDomain([4_000_000, 4_100_000], [5_000_000], { zeroBased: true })[0]).toBe(0);
  });

  it("adds useful padding to a flat price series", () => {
    const [minimum, maximum] = dynamicChartDomain([150, 150], [], { nonNegative: true, minimumSpread: 0.01 });
    expect(minimum).toBeLessThan(150);
    expect(maximum).toBeGreaterThan(150);
  });
});
