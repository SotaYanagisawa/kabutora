import { describe, expect, it } from "vitest";
import { chartAxisTicks, donutArcPath, downsampleChartPoints, linearSvgPath, niceChartAxis } from "./chart-geometry";

describe("lightweight chart geometry", () => {
  it("keeps endpoints and bucket extrema while bounding rendered points", () => {
    const data = Array.from({ length: 10_000 }, (_, index) => ({ value: index === 4_321 ? 99_999 : Math.sin(index / 20) }));
    const sampled = downsampleChartPoints(data, 500, [(item) => item.value]);
    expect(sampled[0].index).toBe(0);
    expect(sampled.at(-1)?.index).toBe(9_999);
    expect(sampled.some((point) => point.index === 4_321)).toBe(true);
    expect(sampled.length).toBeLessThanOrEqual(502);
  });

  it("draws straight segments, and holds the value flat across a step", () => {
    expect(linearSvgPath([{ x: 0, y: 10 }, { x: 10, y: 8 }, { x: 20, y: 3 }])).toBe("M0.00,10.00 L10.00,8.00 L20.00,3.00");
    expect(linearSvgPath([{ x: 0, y: 10 }, { x: 50, y: 4, hold: true }, { x: Number.NaN, y: 1 }])).toBe("M0.00,10.00 L50.00,10.00 L50.00,4.00");
    expect(linearSvgPath([])).toBe("");
  });

  it("matches the zero-based tick spacing used by the portfolio charts", () => {
    expect(chartAxisTicks([0, 12_510_000], 5)).toEqual([0, 3_500_000, 7_000_000, 10_500_000, 12_510_000]);
  });

  it("calculates clean round tick steps with niceChartAxis without trailing arbitrary floats", () => {
    const jpy = niceChartAxis(73_000, 5);
    expect(jpy.domain).toEqual([0, 80_000]);
    expect(jpy.ticks).toEqual([0, 20_000, 40_000, 60_000, 80_000]);

    const usd = niceChartAxis(345, 5);
    expect(usd.domain).toEqual([0, 400]);
    expect(usd.ticks).toEqual([0, 100, 200, 300, 400]);
  });

  it("builds a closed donut segment", () => {
    expect(donutArcPath(100, 100, 40, 70, -Math.PI / 2, 0)).toMatch(/^M100\.00,30\.00 A70\.00,70\.00/u);
    expect(donutArcPath(100, 100, 40, 70, -Math.PI / 2, 0)).toMatch(/ Z$/u);
    expect(donutArcPath(100, 100, 40, 70, 0, -Math.PI / 2)).toContain(" 0 0 0 100.00,30.00");
  });
});
