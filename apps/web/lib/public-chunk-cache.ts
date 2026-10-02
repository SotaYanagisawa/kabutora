import { openBrowserDatabase } from "./browser-database";
import { withDeadline } from "./operation-deadline";

const MAX_MEMORY = 4_000_000, MAX_DISK = 96_000_000;
const memory = new Map<string, string>();
let memoryBytes = 0, disabled = false;
let database: Promise<IDBDatabase> | undefined;
export function clearPublicChunkMemory() { memory.clear(); memoryBytes = 0; }
function remember(key: string, value: string) {
  const previous = memory.get(key); if (previous) memoryBytes -= previous.length * 2;
  memory.delete(key); memory.set(key, value); memoryBytes += value.length * 2;
  while (memoryBytes > MAX_MEMORY) {
    const first = memory.entries().next().value; if (!first) break;
    memory.delete(first[0]); memoryBytes -= first[1].length * 2;
  }
}
function open() {
  return database ??= openBrowserDatabase("kabutora-public-chunks-v2", 1, db => {
    db.createObjectStore("chunks"); db.createObjectStore("metadata");
  });
}
/** Only common public resource/revision/index keys enter this cache. */
export async function readPublicChunkCache(key: string): Promise<string | undefined> {
  const recent = memory.get(key); if (recent !== undefined) { remember(key, recent); return recent; }
  if (disabled || typeof indexedDB === "undefined") return;
  try {
    const db = await withDeadline(open(), 1000, "public-cache-open");
    const value = await withDeadline(new Promise<unknown>((resolve, reject) => {
      const request = db.transaction("chunks").objectStore("chunks").get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }), 250, "public-cache-read");
    if (typeof value === "string") { remember(key, value); return value; }
  } catch { disabled = true; }
}
export async function writePublicChunkCache(key: string, value: string): Promise<void> {
  remember(key, value);
  if (disabled || typeof indexedDB === "undefined") return;
  let transaction: IDBTransaction | undefined;
  try {
    const db = await withDeadline(open(), 1000, "public-cache-open");
    await withDeadline(new Promise<void>((resolve, reject) => {
      transaction = db.transaction(["chunks", "metadata"], "readwrite");
      const chunks = transaction.objectStore("chunks"), metadata = transaction.objectStore("metadata");
      const total = metadata.get("bytes");
      total.onsuccess = () => {
        const used = typeof total.result === "number" ? total.result : 0;
        // Drop only public cached chunks at the ceiling. Vault/outbox databases
        // are separate and are never opened, cleared or evicted here.
        if (used + value.length * 2 > MAX_DISK) { chunks.clear(); metadata.put(value.length * 2, "bytes"); }
        else metadata.put(used + value.length * 2, "bytes");
        chunks.put(value, key);
      };
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction?.error); transaction.onabort = () => reject(transaction?.error);
    }), 250, "public-cache-write");
  } catch { try { transaction?.abort(); } catch {} disabled = true; }
}
