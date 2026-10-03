import { OPTIONAL_STORAGE_TIMEOUT_MS, OperationTimeoutError } from "../ui/operation-deadline";

export function openBrowserDatabase(name: string, version: number, upgrade: (database: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new OperationTimeoutError("browser-storage")), OPTIONAL_STORAGE_TIMEOUT_MS);
    try {
      if (!globalThis.indexedDB) throw new Error("indexeddb_unavailable");
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        try { upgrade(request.result); } catch (error) { request.transaction?.abort(); fail(error); }
      };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        clearTimeout(timer);
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => fail(request.error ?? new Error("indexeddb_open_failed"));
      request.onblocked = () => fail(new Error("indexeddb_open_blocked"));
    } catch (error) { fail(error); }
  });
}
