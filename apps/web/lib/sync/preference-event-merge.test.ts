import { describe, expect, it } from "vitest";
import type { SearchSecurity, UserPreferences } from "@/components/dashboard/types";
import {
  getPreferenceEventSequence,
  mergeLatestPreferences,
  selectLatestWatchlist,
  type PreferenceEventItem,
  type WatchlistEventItem,
} from "./preference-event-merge";

const dummySecurity = (id: string, name: string): SearchSecurity => ({
  id,
  displaySymbol: id,
  name,
  exchangeMic: "XTKS",
  currency: "JPY",
  providerSymbols: {},
});

describe("preference-event-merge", () => {
  describe("getPreferenceEventSequence", () => {
    it("prefers clientSeq when available and positive", () => {
      const seq = getPreferenceEventSequence({
        clientSeq: 1700000005000,
        updatedAt: "2026-09-04T10:00:00.000Z",
      });
      expect(seq).toBe(1700000005000);
    });

    it("falls back to updatedAt timestamp", () => {
      const seq = getPreferenceEventSequence({
        updatedAt: "2026-09-04T12:00:00.000Z",
      });
      expect(seq).toBe(Date.parse("2026-09-04T12:00:00.000Z"));
    });

    it("falls back to clientTimestamp or value.updatedAt", () => {
      const seq1 = getPreferenceEventSequence({
        clientTimestamp: "2026-09-04T12:00:00.000Z",
      });
      expect(seq1).toBe(Date.parse("2026-09-04T12:00:00.000Z"));

      const seq2 = getPreferenceEventSequence({
        value: { updatedAt: "2026-09-04T12:00:00.000Z" },
      });
      expect(seq2).toBe(Date.parse("2026-09-04T12:00:00.000Z"));
    });
  });

  describe("mergeLatestPreferences", () => {
    it("returns base preferences when no events are provided", () => {
      const base: UserPreferences = { summaryRange: "ALL", theme: "light" };
      expect(mergeLatestPreferences(base, [])).toEqual(base);
    });

    it("sorts unordered events chronologically and applies the latest scalar values", () => {
      // Unsorted events where an older event has a higher UUID/arrives later in array
      const olderEvent: PreferenceEventItem = {
        kind: "preferences",
        value: { summaryRange: "3M", theme: "light" },
        updatedAt: "2026-09-01T10:00:00.000Z",
        clientSeq: 100,
      };
      const newerEvent: PreferenceEventItem = {
        kind: "preferences",
        value: { summaryRange: "YTD", theme: "dark" },
        updatedAt: "2026-09-02T10:00:00.000Z",
        clientSeq: 200,
      };

      // Array has newer event first, older event second (simulating random UUID order from Firestore)
      const merged = mergeLatestPreferences(undefined, [newerEvent, olderEvent]);
      expect(merged.summaryRange).toBe("YTD");
      expect(merged.theme).toBe("dark");
    });

    it("correctly unions notification and action sets across events", () => {
      const event1: PreferenceEventItem = {
        kind: "preferences",
        value: {
          readNotifications: ["n1", "n2"],
          acknowledgedActions: ["a1"],
        },
        clientSeq: 100,
      };
      const event2: PreferenceEventItem = {
        kind: "preferences",
        value: {
          readNotifications: ["n2", "n3"],
          acknowledgedActions: ["a2"],
        },
        clientSeq: 200,
      };

      const merged = mergeLatestPreferences(undefined, [event2, event1]);
      expect(merged.readNotifications).toEqual(["n1", "n2", "n3"]);
      expect(merged.acknowledgedActions).toEqual(["a1", "a2"]);
    });

    it("preserves local preferences when local action is newer than remote snapshot", () => {
      const remoteSnapshotEvents: PreferenceEventItem[] = [
        {
          kind: "preferences",
          value: { summaryRange: "3M", theme: "light" },
          clientSeq: 1000,
          updatedAt: "2026-09-04T12:00:00.000Z",
        },
      ];
      const currentLocalPreferences: UserPreferences = {
        summaryRange: "YTD",
        theme: "light",
        updatedAt: "2026-09-04T12:05:00.000Z",
      };

      const merged = mergeLatestPreferences(undefined, remoteSnapshotEvents, currentLocalPreferences);
      expect(merged.summaryRange).toBe("YTD");
      expect(merged.updatedAt).toBe("2026-09-04T12:05:00.000Z");
    });

    it("accepts remote snapshot when remote event is newer than local state", () => {
      const currentLocalPreferences: UserPreferences = {
        summaryRange: "3M",
        updatedAt: "2026-09-04T12:00:00.000Z",
      };
      const remoteSnapshotEvents: PreferenceEventItem[] = [
        {
          kind: "preferences",
          value: { summaryRange: "1W" },
          clientSeq: 2000,
          updatedAt: "2026-09-04T12:10:00.000Z",
        },
      ];

      const merged = mergeLatestPreferences(undefined, remoteSnapshotEvents, currentLocalPreferences);
      expect(merged.summaryRange).toBe("1W");
    });
  });

  describe("selectLatestWatchlist", () => {
    it("returns latest watchlist based on chronological ordering, regardless of array order", () => {
      const sec1 = dummySecurity("7203.T", "Toyota");
      const sec2 = dummySecurity("AAPL", "Apple");

      const eventOlder: WatchlistEventItem = {
        kind: "watchlist",
        value: [sec1],
        clientSeq: 100,
        updatedAt: "2026-09-01T10:00:00.000Z",
      };
      const eventNewer: WatchlistEventItem = {
        kind: "watchlist",
        value: [sec1, sec2],
        clientSeq: 200,
        updatedAt: "2026-09-02T10:00:00.000Z",
      };

      // Shuffled array: newer event first
      const selected = selectLatestWatchlist(undefined, [eventNewer, eventOlder]);
      expect(selected).toEqual([sec1, sec2]);
    });

    it("preserves local watchlist if local timestamp is newer than remote snapshot", () => {
      const sec1 = dummySecurity("7203.T", "Toyota");
      const sec2 = dummySecurity("AAPL", "Apple");

      const remoteEvents: WatchlistEventItem[] = [
        {
          kind: "watchlist",
          value: [sec1],
          clientSeq: 100,
          updatedAt: "2026-09-01T10:00:00.000Z",
        },
      ];

      const localWatchlist = [sec2];
      const localTimestamp = 200; // newer than 100

      const selected = selectLatestWatchlist(undefined, remoteEvents, localWatchlist, localTimestamp);
      expect(selected).toEqual([sec2]);
    });
  });
});
