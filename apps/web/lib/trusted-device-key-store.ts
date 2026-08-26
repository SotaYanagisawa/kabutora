"use client";

const DATABASE_NAME = "kabutora-trusted-device-v1";
const DATABASE_VERSION = 1;
const KEY_STORE = "vaultKeys";

type StoredDeviceKey = {
  id: string;
  key: CryptoKey;
  savedAt: string;
  version: 1;
};

const recordId = (uid: string) => `firebase:${uid}`;

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (!globalThis.indexedDB) {
    reject(new Error("このブラウザでは端末の自動解除を利用できません。"));
    return;
  }
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(KEY_STORE)) {
      request.result.createObjectStore(KEY_STORE, { keyPath: "id" });
    }
  };
  request.onsuccess = () => {
    request.result.onversionchange = () => request.result.close();
    resolve(request.result);
  };
  request.onerror = () => reject(request.error ?? new Error("端末の安全な保存領域を開けませんでした。"));
  request.onblocked = () => reject(new Error("端末の安全な保存領域がほかのタブで使用されています。"));
});

const runTransaction = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
) => {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE, mode);
      transaction.onabort = () => reject(transaction.error ?? new Error("端末の安全な保存領域を更新できませんでした。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("端末の安全な保存領域を更新できませんでした。"));
      operation(transaction.objectStore(KEY_STORE), resolve, reject);
    });
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

export async function saveTrustedDeviceKey(uid: string, key: CryptoKey) {
  if (!uid || !isUsableDeviceKey(key)) throw new Error("端末へ登録できない復号鍵です。");
  const record: StoredDeviceKey = {
    id: recordId(uid),
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

export async function loadTrustedDeviceKey(uid: string): Promise<CryptoKey | null> {
  if (!uid) return null;
  return runTransaction<CryptoKey | null>("readonly", (store, resolve, reject) => {
    const request = store.get(recordId(uid));
    request.onsuccess = () => {
      const record = request.result as StoredDeviceKey | undefined;
      resolve(record?.version === 1 && isUsableDeviceKey(record.key) ? record.key : null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteTrustedDeviceKey(uid: string) {
  if (!uid || !globalThis.indexedDB) return;
  await runTransaction<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(recordId(uid));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
