import { describe, expect, it } from "vitest";
import { isNewerAccountRevision, mergeLatestAccounts } from "./account-event-merge";

describe("account event merge", () => {
  it("keeps an archived account revision even when encrypted events arrive out of order", () => {
    const original = { id: "sbi-nisa", name: "SBI NISA", version: 1, updatedAt: "2026-01-01T00:00:00Z" };
    const archived = { ...original, version: 2, updatedAt: "2026-02-01T00:00:00Z", archivedAt: "2026-02-01T00:00:00Z" };
    expect(mergeLatestAccounts([original], [archived, original])).toEqual([archived]);
  });

  it("detects an account archive as a synchronized update", () => {
    expect(isNewerAccountRevision(
      { id: "paypay-taxable", version: 2, archivedAt: "2026-02-01T00:00:00Z" },
      { id: "paypay-taxable", version: 1 },
    )).toBe(true);
  });
});
