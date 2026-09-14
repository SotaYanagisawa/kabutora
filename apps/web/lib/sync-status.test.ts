import { describe, expect, it } from "vitest";
import { pendingSyncIndicatorDelay } from "./sync-status";

describe("pendingSyncIndicatorDelay", () => {
  it("keeps ordinary online preference synchronization in the background", () => {
    expect(pendingSyncIndicatorDelay(true)).toBe(10_000);
  });

  it("warns quickly when a change is waiting offline", () => {
    expect(pendingSyncIndicatorDelay(false)).toBe(300);
  });
});
