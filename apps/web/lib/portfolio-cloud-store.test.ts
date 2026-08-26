import { describe, expect, it } from "vitest";
import { portfolioEventSnapshotSignature, portfolioEventsSnapshotIsReady } from "./portfolio-cloud-store";

describe("portfolio events startup readiness", () => {
  it("waits for the server snapshot while online", () => {
    expect(portfolioEventsSnapshotIsReady(true, true)).toBe(false);
    expect(portfolioEventsSnapshotIsReady(false, true)).toBe(true);
  });

  it("accepts the cached snapshot when offline", () => {
    expect(portfolioEventsSnapshotIsReady(true, false)).toBe(true);
  });

  it("identifies metadata-only snapshots regardless of document order", () => {
    expect(portfolioEventSnapshotSignature([{ id: "event-b" }, { id: "event-a" }])).toBe("event-a|event-b");
    expect(portfolioEventSnapshotSignature([{ id: "event-a" }, { id: "event-b" }])).toBe("event-a|event-b");
  });
});
