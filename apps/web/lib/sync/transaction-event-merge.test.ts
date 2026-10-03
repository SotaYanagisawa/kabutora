import { describe, expect, it } from "vitest";
import { diffTransactionChanges, mergeLatestTransactions } from "./transaction-event-merge";

const transaction = (id: string, version: number, updatedAt: string, quantity: string) => ({ id, version, updatedAt, quantity });

describe("transaction event merging", () => {
  it("keeps the newest edited transaction regardless of event order", () => {
    const original = transaction("trade-1", 1, "2026-01-01T00:00:00.000Z", "10");
    const firstEdit = transaction("trade-1", 2, "2026-02-01T00:00:00.000Z", "12");
    const latestEdit = transaction("trade-1", 3, "2026-03-01T00:00:00.000Z", "15");

    expect(mergeLatestTransactions([original], [latestEdit, firstEdit])).toEqual([latestEdit]);
  });

  it("uses the latest update time when versions match", () => {
    const earlier = transaction("trade-1", 2, "2026-02-01T00:00:00.000Z", "12");
    const later = transaction("trade-1", 2, "2026-02-02T00:00:00.000Z", "13");

    expect(mergeLatestTransactions([earlier], [later])).toEqual([later]);
  });

  it("separates encrypted upserts from deletion tombstones", () => {
    const original = transaction("trade-1", 1, "2026-01-01T00:00:00.000Z", "10");
    const removed = transaction("trade-2", 1, "2026-01-01T00:00:00.000Z", "5");
    const edited = transaction("trade-1", 2, "2026-02-01T00:00:00.000Z", "20");
    const added = transaction("trade-3", 1, "2026-02-01T00:00:00.000Z", "7");

    expect(diffTransactionChanges([original, removed], [edited, added])).toEqual({
      upserts: [edited, added],
      deletions: [removed],
    });
  });
});
