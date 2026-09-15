import { describe, expect, it } from "vitest";
import { isActivelyUpdating, resolveUpdatingMessage } from "./updating-status";

describe("updating-status", () => {
  it("detects when no update is in progress", () => {
    const updating = isActivelyUpdating({
      isManualRefreshing: false,
      quoteStatus: "ready",
      historyStatus: "ready",
      distributionStatus: "ready",
      benchmarkStatus: "ready",
    });
    expect(updating).toBe(false);
  });

  it("detects active history loading", () => {
    const options = {
      isManualRefreshing: false,
      quoteStatus: "ready" as const,
      historyStatus: "loading" as const,
      distributionStatus: "ready" as const,
      benchmarkStatus: "ready" as const,
    };
    expect(isActivelyUpdating(options)).toBe(true);
    expect(resolveUpdatingMessage(options)).toBe("履歴データを取得中…");
  });

  it("detects active quote loading", () => {
    const options = {
      isManualRefreshing: false,
      quoteStatus: "loading" as const,
      historyStatus: "ready" as const,
      distributionStatus: "ready" as const,
      benchmarkStatus: "ready" as const,
    };
    expect(isActivelyUpdating(options)).toBe(true);
    expect(resolveUpdatingMessage(options)).toBe("株価データを更新中…");
  });

  it("detects simultaneous quote and history loading", () => {
    const options = {
      isManualRefreshing: false,
      quoteStatus: "loading" as const,
      historyStatus: "loading" as const,
      distributionStatus: "ready" as const,
      benchmarkStatus: "ready" as const,
    };
    expect(isActivelyUpdating(options)).toBe(true);
    expect(resolveUpdatingMessage(options)).toBe("市場データと履歴を更新中…");
  });

  it("detects manual refresh", () => {
    const options = {
      isManualRefreshing: true,
      quoteStatus: "ready" as const,
      historyStatus: "ready" as const,
      distributionStatus: "ready" as const,
      benchmarkStatus: "ready" as const,
    };
    expect(isActivelyUpdating(options)).toBe(true);
    expect(resolveUpdatingMessage(options)).toBe("株価データを更新中…");
  });

  it("detects distribution and benchmark loading", () => {
    const distOptions = {
      isManualRefreshing: false,
      quoteStatus: "ready" as const,
      historyStatus: "ready" as const,
      distributionStatus: "loading" as const,
      benchmarkStatus: "ready" as const,
    };
    expect(isActivelyUpdating(distOptions)).toBe(true);
    expect(resolveUpdatingMessage(distOptions)).toBe("配当データを更新中…");

    const benchOptions = {
      isManualRefreshing: false,
      quoteStatus: "ready" as const,
      historyStatus: "ready" as const,
      distributionStatus: "ready" as const,
      benchmarkStatus: "loading" as const,
    };
    expect(isActivelyUpdating(benchOptions)).toBe(true);
    expect(resolveUpdatingMessage(benchOptions)).toBe("為替・指標を取得中…");
  });
});
