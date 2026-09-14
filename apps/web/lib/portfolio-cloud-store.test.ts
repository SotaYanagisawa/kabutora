import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFirebasePortfolioCloudStore,
  portfolioEventSnapshotSignature,
  portfolioEventsSnapshotIsReady,
  PORTFOLIO_EVENT_COMPACTION_THRESHOLD,
} from "./portfolio-cloud-store";
import { decryptVaultRecord, encryptVaultRecord } from "./vault-crypto";
import type { SearchSecurity, UserPreferences } from "@/components/dashboard/types";

const documents = new Map<string, any>();
const commits: Array<Array<{ kind: "set" | "delete"; path: string }>> = [];
vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join("/") }),
    runTransaction: async (_db: unknown, operation: (tx: any) => Promise<unknown>) => {
      const draft = new Map(documents);
      const changes: Array<{ kind: "set" | "delete"; path: string }> = [];
      const result = await operation({
        get: async (ref: { path: string }) => ({ exists: () => draft.has(ref.path), data: () => draft.get(ref.path) }),
        set: (ref: { path: string }, data: unknown) => { draft.set(ref.path, data); changes.push({ kind: "set", path: ref.path }); },
        delete: (ref: { path: string }) => { draft.delete(ref.path); changes.push({ kind: "delete", path: ref.path }); },
      });
      documents.clear(); for (const [path, data] of draft) documents.set(path, data);
      commits.push(changes);
      return result;
    },
  };
});

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

describe("encrypted watchlist and preferences events", () => {
  const generateKey = async () => crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  it("encrypts and decrypts watchlist events without leaking plaintext", async () => {
    const key = await generateKey();
    const watchlist: SearchSecurity[] = [
      {
        id: "sec-us-aapl",
        displaySymbol: "AAPL",
        name: "Apple Inc.",
        exchangeMic: "XNAS",
        currency: "USD",
        providerSymbols: { yahoo: "AAPL" },
      },
    ];

    const encrypted = await encryptVaultRecord(key, { kind: "watchlist", value: watchlist });
    expect(encrypted.algorithm).toBe("AES-256-GCM");
    expect(encrypted.ciphertext).not.toContain("AAPL");
    expect(encrypted.ciphertext).not.toContain("Apple");

    const decrypted = await decryptVaultRecord<{ kind: "watchlist"; value: SearchSecurity[] }>(key, encrypted);
    expect(decrypted?.kind).toBe("watchlist");
    expect(decrypted?.value).toEqual(watchlist);
  });

  it("encrypts and decrypts user preferences events without leaking plaintext", async () => {
    const key = await generateKey();
    const preferences: UserPreferences = {
      theme: "dark",
      accentTheme: "forest",
      displayCurrency: "USD",
      autoRefresh: true,
      updateFrequency: 30,
      summaryMarketFilter: "US",
    };

    const encrypted = await encryptVaultRecord(key, { kind: "preferences", value: preferences });
    expect(encrypted.algorithm).toBe("AES-256-GCM");
    expect(encrypted.ciphertext).not.toContain("forest");
    expect(encrypted.ciphertext).not.toContain("USD");

    const decrypted = await decryptVaultRecord<{ kind: "preferences"; value: UserPreferences }>(key, encrypted);
    expect(decrypted?.kind).toBe("preferences");
    expect(decrypted?.value).toEqual(preferences);
  });
});

describe("revisioned cloud saves and compaction", () => {
  const envelope: any = { format: "kabutora-encrypted-vault", version: 2, keyId: "generation-2", ownerUid: "u1", revision: 2 };
  const store = () => createFirebasePortfolioCloudStore({} as any);
  beforeEach(() => { documents.clear(); commits.length = 0; documents.set("users/u1/vaults/default", { ...envelope, revision: 1 }); });
  it("retains the existing 40-event compaction threshold", () => expect(PORTFOLIO_EVENT_COMPACTION_THRESHOLD).toBe(40));
  it("commits a checkpoint before acknowledging and deleting its 550 incorporated events", async () => {
    const ids = Array.from({ length: 550 }, (_, i) => `evt-${i}`);
    for (const id of ids) documents.set(`users/u1/events/${id}`, { ownerUid: "u1" });
    await store().compactVaultWithEvents("u1", envelope, ids);
    expect(commits[0]).toEqual([{ kind: "set", path: "users/u1/vaults/default" }]);
    expect(commits.every((commit) => commit.length <= 500)).toBe(true);
    expect(documents.get("users/u1/vaults/default").revision).toBe(2);
    expect([...documents.keys()].filter((path) => path.includes("/events/"))).toEqual([]);
    expect([...documents.keys()].filter((path) => path.includes("/receipts/"))).toHaveLength(550);
  });
  it("preserves events when another device already committed the expected revision", async () => {
    documents.set("users/u1/vaults/default", envelope);
    documents.set("users/u1/events/pending", { ownerUid: "u1" });
    await expect(store().compactVaultWithEvents("u1", envelope, ["pending"])).rejects.toThrow("vault_revision_changed");
    expect(documents.has("users/u1/events/pending")).toBe(true);
    expect(commits).toEqual([]);
  });
  it("rejects old generation writes, but acknowledges an already incorporated retry", async () => {
    const event: any = { ownerUid: "u1", keyId: "old-generation", payload: { iv: "i", ciphertext: "c" } };
    await expect(store().saveEvent("u1", "old", event)).rejects.toThrow("vault_generation_obsolete");
    documents.set("users/u1/receipts/old", { ownerUid: "u1" });
    await expect(store().saveEvent("u1", "old", event)).resolves.toBeUndefined();
    expect(documents.has("users/u1/events/old")).toBe(false);
  });
  it("acknowledges duplicate delivery and refuses to replace different ciphertext", async () => {
    const event: any = { ownerUid: "u1", keyId: "generation-2", payload: { iv: "i", ciphertext: "c" } };
    await store().saveEvent("u1", "same", event);
    await expect(store().saveEvent("u1", "same", event)).resolves.toBeUndefined();
    await expect(store().saveEvent("u1", "same", { ...event, payload: { ...event.payload, ciphertext: "different" } })).rejects.toThrow("event_id_conflict");
  });
});
