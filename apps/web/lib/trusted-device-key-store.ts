"use client";

import { openBrowserDatabase } from "./browser-database";
import { OPTIONAL_STORAGE_TIMEOUT_MS, withDeadline } from "./operation-deadline";
import { isKabutoraVaultEnvelope, type KabutoraVaultEnvelope } from "./vault-crypto";

const DATABASE_NAME = "kabutora-trusted-device-v1";
const DATABASE_VERSION = 1;
const KEY_STORE = "vaultKeys";

type StoredDeviceKey = {
  id: string;
  key: CryptoKey;
  savedAt: string;
  version: 1;
};

const recordId = (uid: string, generation?: string) => `firebase:${uid}${generation ? `:generation:${generation}` : ""}`;
const draftId = (uid: string) => `firebase:${uid}:verified-migration`;
export type VerifiedRecoveryDraft = {
  id: string; uid: string; version: 2; previousGeneration: string | null;
  envelope: KabutoraVaultEnvelope; key: CryptoKey; savedAt: string;
};

const openDatabase = () => openBrowserDatabase(DATABASE_NAME, DATABASE_VERSION, (database) => {
  if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE, { keyPath: "id" });
});

const runTransaction = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
) => {
  const started = performance.now();
  const database = await openDatabase();
  let pendingTransaction: IDBTransaction | undefined;
  try {
    return await withDeadline(new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE, mode);
      pendingTransaction = transaction;
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error("端末の安全な保存領域を更新できませんでした。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("端末の安全な保存領域を更新できませんでした。"));
      operation(transaction.objectStore(KEY_STORE), (value) => { result = value; }, reject);
    }), Math.max(1, OPTIONAL_STORAGE_TIMEOUT_MS - (performance.now() - started)), "device-key");
  } catch (error) {
    try { pendingTransaction?.abort(); } catch {}
    throw error;
  } finally {
    database.close();
  }
};

const isUsableDeviceKey = (value: unknown): value is CryptoKey => {
  if (!value || typeof value !== "object") return false;
  const key = value as CryptoKey;
  const algorithm = key.algorithm as KeyAlgorithm | undefined;
  return key.type === "secret"
    && key.extractable === false
    && algorithm?.name === "AES-GCM"
    && key.usages.includes("decrypt");
};

export async function saveTrustedDeviceKey(uid: string, key: CryptoKey, generation?: string) {
  if (!uid || !isUsableDeviceKey(key)) throw new Error("端末へ登録できない復号鍵です。");
  const record: StoredDeviceKey = {
    id: recordId(uid, generation),
    key,
    savedAt: new Date().toISOString(),
    version: 1,
  };
  await runTransaction<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function loadTrustedDeviceKey(uid: string, generation?: string): Promise<CryptoKey | null> {
  if (!uid) return null;
  return runTransaction<CryptoKey | null>("readonly", (store, resolve, reject) => {
    const request = store.get(recordId(uid, generation));
    request.onsuccess = () => {
      const record = request.result as StoredDeviceKey | undefined;
      if (record?.version === 1 && isUsableDeviceKey(record.key)) resolve(record.key);
      else if (generation) {
        // Compatibility with keys enrolled before generation-specific storage.
        const legacy = store.get(recordId(uid));
        legacy.onsuccess = () => resolve(isUsableDeviceKey(legacy.result?.key) ? legacy.result.key : null);
        legacy.onerror = () => reject(legacy.error);
      } else resolve(null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteTrustedDeviceKey(uid: string) {
  if (!uid) return;
  await runTransaction<void>("readwrite", (store, resolve, reject) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      if (cursor.key === recordId(uid) || String(cursor.key).startsWith(recordId(uid) + ":")) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/** Called only after the user has verified recovery locally. No recovery secret
 * is stored: only encrypted data and a non-extractable trusted-device key. */
export async function saveVerifiedRecoveryDraft(uid: string, previousGeneration: string | null, envelope: KabutoraVaultEnvelope, key: CryptoKey) {
  if (envelope.version !== 2 || envelope.ownerUid !== uid || !envelope.keyId || !isUsableDeviceKey(key)) throw new Error("invalid_recovery_draft");
  const savedAt = new Date().toISOString();
  await runTransaction<void>("readwrite", (store) => {
    store.put({ id: draftId(uid), uid, version: 2, previousGeneration, envelope, key, savedAt } satisfies VerifiedRecoveryDraft);
    store.put({ id: recordId(uid, envelope.keyId), key, savedAt, version: 1 } satisfies StoredDeviceKey);
  });
}
export async function loadVerifiedRecoveryDraft(uid: string): Promise<VerifiedRecoveryDraft | null> {
  return runTransaction<VerifiedRecoveryDraft | null>("readonly", (store, resolve, reject) => {
    const request = store.get(draftId(uid));
    request.onsuccess = () => {
      const draft = request.result as VerifiedRecoveryDraft | undefined;
      resolve(draft?.uid === uid && draft.version === 2 && isUsableDeviceKey(draft.key) && isKabutoraVaultEnvelope(draft.envelope) && draft.envelope.ownerUid === uid ? draft : null);
    };
    request.onerror = () => reject(request.error);
  });
}
export async function clearVerifiedRecoveryDraft(uid: string) {
  await runTransaction<void>("readwrite", (store) => { store.delete(draftId(uid)); });
}
