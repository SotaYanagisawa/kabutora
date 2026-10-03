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
