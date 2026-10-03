import { openBrowserDatabase } from "../sync/browser-database";
import { withDeadline, OPTIONAL_STORAGE_TIMEOUT_MS } from "../ui/operation-deadline";
import type { KabutoraVaultEnvelope } from "./vault-crypto";

export type VerifiedVault = { uid: string; envelope: KabutoraVaultEnvelope; verifiedAt: string };
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const started = performance.now();
  const db = await openBrowserDatabase("kabutora-verified-vault-v1", 1, (db) => db.createObjectStore("snapshots", { keyPath: "uid" }));
  let tx: IDBTransaction | undefined;
  try {
    return await withDeadline(new Promise<T>((resolve, reject) => {
      tx = db.transaction("snapshots", mode);
      const request = operation(tx.objectStore("snapshots"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx?.error ?? new Error("snapshot_storage_unavailable"));
    }), Math.max(1, OPTIONAL_STORAGE_TIMEOUT_MS - (performance.now() - started)), "verified-vault-cache");
  } catch (error) { try { tx?.abort(); } catch {} throw error; }
  finally { db.close(); }
}
export const readVerifiedVault = (uid: string) => transaction<VerifiedVault | undefined>("readonly", (store) => store.get(uid));
export const saveVerifiedVault = (value: VerifiedVault) => transaction("readwrite", (store) => store.put(value));
