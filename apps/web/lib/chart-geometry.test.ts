import { describe, expect, it } from "vitest";
import { chartAxisTicks, donutArcPath, downsampleChartPoints, monotoneSvgPath } from "./chart-geometry";

describe("lightweight chart geometry", () => {
  it("keeps endpoints and bucket extrema while bounding rendered points", () => {
    const data = Array.from({ length: 10_000 }, (_, index) => ({ value: index === 4_321 ? 99_999 : Math.sin(index / 20) }));
    const sampled = downsampleChartPoints(data, 500, [(item) => item.value]);
    expect(sampled[0].index).toBe(0);
    expect(sampled.at(-1)?.index).toBe(9_999);
    expect(sampled.some((point) => point.index === 4_321)).toBe(true);
    expect(sampled.length).toBeLessThanOrEqual(502);
  });

  it("creates a smooth finite path without overshooting a monotone segment", () => {
    const path = monotoneSvgPath([{ x: 0, y: 10 }, { x: 10, y: 8 }, { x: 20, y: 3 }]);
    expect(path).toMatch(/^M0\.00,10\.00 C/u);
    expect(path).not.toContain("NaN");
  });

  it("matches the zero-based tick spacing used by the portfolio charts", () => {
    expect(chartAxisTicks([0, 12_510_000], 5)).toEqual([0, 3_500_000, 7_000_000, 10_500_000, 12_510_000]);
  });

  it("builds a closed donut segment", () => {
    expect(donutArcPath(100, 100, 40, 70, -Math.PI / 2, 0)).toMatch(/^M100\.00,30\.00 A70\.00,70\.00/u);
    expect(donutArcPath(100, 100, 40, 70, -Math.PI / 2, 0)).toMatch(/ Z$/u);
    expect(donutArcPath(100, 100, 40, 70, 0, -Math.PI / 2)).toContain(" 0 0 0 100.00,30.00");
  });
});
