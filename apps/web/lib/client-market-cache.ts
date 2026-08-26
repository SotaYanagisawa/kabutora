const DATABASE_NAME = "kabutora-market-data";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";

type CacheEnvelope<T> = {
  schemaVersion: number;
  savedAt: string;
  value: T;
};

let persistenceRequested = false;

async function requestPersistentStorage() {
  if (persistenceRequested || typeof navigator === "undefined") return;
  persistenceRequested = true;
  try { await navigator.storage?.persist?.(); } catch { /* Best effort on restricted iOS contexts. */ }
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("market_cache_open_failed"));
    request.onblocked = () => reject(new Error("market_cache_open_blocked"));
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
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("market_cache_write_failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("market_cache_write_aborted"));
    });
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
  if (typeof indexedDB !== "undefined") {
    try {
      const cached = await readIndexedValue<CacheEnvelope<T>>(key);
      if (cached?.value != null) return cached.value;
    } catch {
      // A browser can deny IndexedDB in private/restricted contexts. Legacy data is
      // still useful as a read-only fallback and network fetching remains available.
    }
  }
  return parseLegacyValue<T>(legacyKeys);
}

export async function writeMarketCache<T>(key: string, value: T, legacyKeys: string[] = []) {
  if (typeof indexedDB === "undefined") return false;
  try {
    await requestPersistentStorage();
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
