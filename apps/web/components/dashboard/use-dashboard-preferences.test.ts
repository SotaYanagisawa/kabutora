import { describe, expect, it } from "vitest";
import { resolveInitialPreferences } from "./use-dashboard-preferences";
import type { Seed } from "./types";

function memoryStorage(values: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(values));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => { map.delete(key); },
    setItem: (key, value) => { map.set(key, value); },
  };
}

const seed = (overrides: Partial<Seed> = {}, baseCurrency = "JPY") => ({
  portfolio: { id: "p", baseCurrency },
  accounts: [],
  securities: [],
  transactions: [],
  ...overrides,
}) as unknown as Seed;

describe("resolveInitialPreferences", () => {
  it("defaults display currencies to the portfolio base currency", () => {
    expect(resolveInitialPreferences(seed({}, "USD"), memoryStorage())).toMatchObject({ displayCurrency: "USD", dividendDisplayCurrency: "USD" });
    expect(resolveInitialPreferences(seed(), memoryStorage())).toMatchObject({ displayCurrency: "JPY", dividendDisplayCurrency: "JPY" });
  });

  it("prefers cloud preferences over browser storage, and validates stored values", () => {
    const storage = memoryStorage({
      "kabutora-theme": "dark",
      "kabutora-accent": "neon",
      "kabutora-update-frequency": "7",
      "kabutora-display-currency": "USD",
      "kabutora-market-filter": "US",
      "kabutora-summary-custom-range": "{broken",
    });
    const local = resolveInitialPreferences(seed(), storage);
    expect(local).toMatchObject({ dark: true, accentTheme: "graphite", updateFrequency: 15, displayCurrency: "USD", summaryMarketFilter: "US", customRange: null, needsCloudMigration: true });
    const cloud = resolveInitialPreferences(seed({ preferences: { theme: "light", displayCurrency: "NATIVE", updatedAt: "2026-01-01T00:00:00Z" } }), storage);
    expect(cloud).toMatchObject({ dark: false, displayCurrency: "NATIVE", needsCloudMigration: false });
  });

  it("keeps a setting edited on this device after the cloud copy, and reports it for re-sync", () => {
    const storage = memoryStorage({
      "kabutora-summary-market-filter": "US",
      "kabutora-display-currency": "USD",
      "kabutora-summary-range": "1M",
      "kabutora-preference-clocks-v1": JSON.stringify({ summaryMarketFilter: 2_000, displayCurrency: 500, summaryRange: 2_000 }),
    });
    const resolved = resolveInitialPreferences(seed({
      preferences: { summaryMarketFilter: "JP", displayCurrency: "JPY", summaryRange: "1W", theme: "dark", updatedAt: new Date(1_000).toISOString() },
      sync: { appliedEventIds: [], preferenceSequences: { summaryMarketFilter: 1_000, displayCurrency: 1_000, summaryRange: 3_000 } },
    }), storage);
    // Newer local edit wins; an older local edit and a newer remote edit both defer to the cloud.
    expect(resolved).toMatchObject({ summaryMarketFilter: "US", displayCurrency: "JPY", range: "1W", dark: true });
    expect(resolved.newerLocalClocks).toEqual({ summaryMarketFilter: 2_000 });
  });

  it("falls back to the cloud update time when a field has no per-field sequence, and ignores malformed clocks", () => {
    const storage = memoryStorage({
      "kabutora-dividend-tab": "history",
      "kabutora-preference-clocks-v1": JSON.stringify({ dividendActiveTab: 5_000, theme: "soon", summaryRange: -1 }),
    });
    const resolved = resolveInitialPreferences(seed({ preferences: { dividendActiveTab: "securities", updatedAt: new Date(4_000).toISOString() } }), storage);
    expect(resolved.dividendActiveTab).toBe("history");
    expect(resolved.newerLocalClocks).toEqual({ dividendActiveTab: 5_000 });
    expect(resolveInitialPreferences(seed({ preferences: { dividendActiveTab: "securities", updatedAt: new Date(6_000).toISOString() } }), storage).dividendActiveTab).toBe("securities");
    expect(resolveInitialPreferences(seed(), memoryStorage({ "kabutora-preference-clocks-v1": "{broken" })).newerLocalClocks).toEqual({});
  });

  it("uses a stored watchlist only when the cloud has none, and merges read/acknowledged IDs", () => {
    const storage = memoryStorage({
      "kabutora-watchlist-v1": JSON.stringify([{ id: "sec-7203" }]),
      "kabutora-read-notifications-v1": JSON.stringify(["a", "b"]),
    });
    expect(resolveInitialPreferences(seed(), storage)).toMatchObject({ watchlist: [{ id: "sec-7203" }], hasSavedWatchlist: true });
    const fromCloud = resolveInitialPreferences(seed({ watchlist: [{ id: "sec-6758" }] as Seed["watchlist"], preferences: { readNotifications: ["b", "c"] } }), storage);
    expect(fromCloud.watchlist).toEqual([{ id: "sec-6758" }]);
    expect(fromCloud.readNotificationIds).toEqual(["a", "b", "c"]);
  });
});
