import { describe, expect, it } from "vitest";
import demo from "../data/demo-seed.json";
import { validatePortfolio } from "./portfolio-validation";
import { replayPortfolioEvents, validatePortfolioEvent, type DecryptedPortfolioEvent } from "./portfolio-events";

const seed = validatePortfolio(demo);
describe("validated deterministic event replay", () => {
  it("preserves legacy security identifiers and ISO transaction dates", () => {
    expect(seed.securities[0]!.id).toBe("sec-7203-xtks");
    expect(seed.transactions[0]!.tradeDate).toContain("T");
  });
  it("rejects malformed decrypted arithmetic inputs before calculations", () => {
    expect(() => validatePortfolio({ ...seed, transactions: [{ ...seed.transactions[0], quantity: "NaN" }] })).toThrow();
    expect(() => validatePortfolioEvent({ kind: "security", value: { ...seed.securities[0], priceUnit: "0" } })).toThrow();
    expect(() => validatePortfolioEvent({ kind: "preferences", value: { displayCurrency: "INVALID" } })).toThrow();
  });
  it("retains deletions through compaction and prevents an old offline upsert resurrecting a trade", () => {
    const transaction = seed.transactions[0]!;
    const deleted = replayPortfolioEvents(seed, [{ id: "delete", payload: { kind: "transaction-delete", value: { id: transaction.id, deletedAt: "2026-01-01T00:00:00Z" } } }]);
    const replayed = replayPortfolioEvents(deleted, [{ id: "offline-old", payload: { kind: "transaction", value: transaction, clientTimestamp: "2025-05-01T00:00:00Z" } }]);
    expect(replayed.transactions.find((value) => value.id === transaction.id)).toBeUndefined();
    expect(replayed.sync?.appliedEventIds).toEqual(["delete", "offline-old"]);
  });
  it("merges independent preference updates without reverting a newer filter after compaction", () => {
    const updates: DecryptedPortfolioEvent[] = [
      { id: "us", payload: { kind: "preferences", value: { summaryMarketFilter: "US" }, clientSeq: 200 } },
      { id: "theme", payload: { kind: "preferences", value: { theme: "dark" }, clientSeq: 100 } },
    ];
    const compacted = replayPortfolioEvents(seed, updates);
    const result = replayPortfolioEvents(compacted, [{ id: "late-jp", payload: { kind: "preferences", value: { summaryMarketFilter: "JP", dividendMarketFilter: "JP" }, clientSeq: 150 } }]);
    expect(result.preferences).toMatchObject({ summaryMarketFilter: "US", dividendMarketFilter: "JP", theme: "dark" });
    expect(replayPortfolioEvents(result, updates)).toBe(result);
  });
  it("produces the same snapshot for reversed delivery order", () => {
    const events: DecryptedPortfolioEvent[] = [
      { id: "a", payload: { kind: "watchlist", value: [seed.securities[0]!], clientSeq: 50 } },
      { id: "b", payload: { kind: "watchlist", value: [seed.securities[1]!], clientSeq: 100 } },
    ];
    expect(replayPortfolioEvents(seed, events)).toEqual(replayPortfolioEvents(seed, [...events].reverse()));
  });
  it("does not revert legacy snapshot preferences when an older offline event arrives", () => {
    const base = { ...seed, preferences: { summaryMarketFilter: "US" as const, updatedAt: "2026-01-01T00:00:00Z" } };
    const result = replayPortfolioEvents(base, [{ id: "old", payload: { kind: "preferences", value: { summaryMarketFilter: "JP", theme: "dark" }, clientTimestamp: "2025-01-01T00:00:00Z" } }]);
    expect(result.preferences).toMatchObject({ summaryMarketFilter: "US", theme: "dark" });
  });
  it("uses the original per-setting edit sequence after a delayed preference save", () => {
    const result = replayPortfolioEvents(seed, [
      { id: "new-us", payload: { kind: "preferences", value: { summaryMarketFilter: "US", preferenceSequences: { summaryMarketFilter: 200 } }, clientSeq: 210 } },
      { id: "delayed-jp", payload: { kind: "preferences", value: { summaryMarketFilter: "JP", preferenceSequences: { summaryMarketFilter: 100 } }, clientSeq: 300 } },
    ]);
    expect(result.preferences?.summaryMarketFilter).toBe("US");
    expect(result.sync?.preferenceSequences?.summaryMarketFilter).toBe(200);
  });
});
