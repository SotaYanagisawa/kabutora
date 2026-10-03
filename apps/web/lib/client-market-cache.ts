import type { ServerMarketSnapshot } from "./server-market-types";
import { openBrowserDatabase } from "./browser-database";
import { OPTIONAL_STORAGE_TIMEOUT_MS, withDeadline } from "./operation-deadline";
import { validateCachedMarketPayload, validateMarketPayload } from "./market-payload-validation";

const DATABASE_NAME = "kabutora-market-data";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";

export type PersistedServerSnapshot = {
  etag: string;
  snapshot: ServerMarketSnapshot;
  savedAt: string;
};

type CacheEnvelope<T> = {
  schemaVersion: number;
  savedAt: string;
  value: T;
};

let persistenceRequested = false;

async function requestPersistentStorage() {
  if (persistenceRequested || typeof navigator === "undefined") return;
  persistenceRequested = true;
  try { const task = navigator.storage?.persist?.(); if (task) await withDeadline(task, OPTIONAL_STORAGE_TIMEOUT_MS, "storage-persistence"); } catch { /* Best effort on restricted iOS contexts. */ }
}

function openDatabase() {
  return openBrowserDatabase(DATABASE_NAME, DATABASE_VERSION, (database) => {
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
  });
}

async function readIndexedValue<T>(key: string) {
  const database = await openDatabase();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("market_cache_read_failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("market_cache_read_aborted"));
    });
  } finally {
    database.close();
  }
}

async function writeIndexedValue<T>(key: string, value: T) {
  const database = await openDatabase();
  let pending: IDBTransaction | undefined;
  try {
    await withDeadline(new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      pending = transaction;
      transaction.objectStore(STORE_NAME).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("market_cache_write_failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("market_cache_write_aborted"));
    }), OPTIONAL_STORAGE_TIMEOUT_MS, "market-cache-write");
  } catch (error) {
    try { pending?.abort(); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function parseLegacyValue<T>(keys: string[]) {
  for (const key of keys) {
    const serialized = localStorage.getItem(key);
    if (!serialized) continue;
    try {
      return JSON.parse(serialized) as T;
    } catch {
      localStorage.removeItem(key);
    }
  }
  return null;
}

export async function readMarketCache<T>(key: string, legacyKeys: string[] = []) {
  try {
    if (globalThis.indexedDB) {
      const cached = await withDeadline(readIndexedValue<CacheEnvelope<T>>(key), OPTIONAL_STORAGE_TIMEOUT_MS, "market-cache");
      if (cached?.value != null) { validateCachedMarketPayload(cached.value); return cached.value; }
    }
  } catch { /* Restricted storage does not block network reads. */ }
  try { const legacy = parseLegacyValue<T>(legacyKeys); if (legacy) validateCachedMarketPayload(legacy); return legacy; } catch { return null; }
}

export async function writeMarketCache<T>(key: string, value: T, legacyKeys: string[] = []) {
  try {
    if (!globalThis.indexedDB) return false;
    void requestPersistentStorage();
    await writeIndexedValue<CacheEnvelope<T>>(key, {
      schemaVersion: DATABASE_VERSION,
      savedAt: new Date().toISOString(),
      value,
    });
    for (const legacyKey of legacyKeys) localStorage.removeItem(legacyKey);
    return true;
  } catch {
    return false;
  }
}

export async function readServerSnapshotCache(mode: "full" | "compact"): Promise<PersistedServerSnapshot | null> {
  try {
    if (!globalThis.indexedDB) return null;
    const cached = await withDeadline(readIndexedValue<CacheEnvelope<PersistedServerSnapshot>>(`server-snapshot:${mode}`), OPTIONAL_STORAGE_TIMEOUT_MS, "market-snapshot-cache");
    if (cached?.value?.snapshot && cached.value.etag) {
      validateMarketPayload(cached.value.snapshot);
      return cached.value;
    }
  } catch {
    // Return null if IndexedDB is inaccessible or blocked
  }
  return null;
}

export async function writeServerSnapshotCache(
  mode: "full" | "compact",
  snapshot: ServerMarketSnapshot,
  etag: string,
): Promise<boolean> {
  try {
    if (!globalThis.indexedDB || !etag) return false;
    void requestPersistentStorage();
    await writeIndexedValue<CacheEnvelope<PersistedServerSnapshot>>(`server-snapshot:${mode}`, {
      schemaVersion: DATABASE_VERSION,
      savedAt: new Date().toISOString(),
      value: {
        etag,
        snapshot,
        savedAt: snapshot.savedAt ?? new Date().toISOString(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

const COMPACT_QUOTES_KEY = "kabutora-compact-quotes-v1";

export function readCompactQuotesCache(): Record<string, import("./server-market-types").ServerRemoteQuote> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(COMPACT_QUOTES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, import("./server-market-types").ServerRemoteQuote>;
  } catch {}
  return {};
}

export function writeCompactQuotesCache(quotes: Record<string, import("./server-market-types").ServerRemoteQuote>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(COMPACT_QUOTES_KEY, JSON.stringify(quotes));
  } catch {}
}

export function clearCompactQuotesCache() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(COMPACT_QUOTES_KEY);
  } catch {}
}
