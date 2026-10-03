"use client";

import type { EncryptedPortfolioEvent } from "./portfolio-cloud-store";
import type { DeviceTrustMode } from "./firebase-config";
import { openBrowserDatabase } from "./browser-database";
import { OPTIONAL_STORAGE_TIMEOUT_MS, withDeadline } from "../ui/operation-deadline";

const DATABASE_NAME = "kabutora-offline-queue-v1";
const STORE_NAME = "pendingEvents";
export type QueuedPortfolioEvent = {
  id: string; userId: string; monotonicSeq: number; queuedAt: string;
  event: EncryptedPortfolioEvent; retryCount: number; nextAttemptAt?: number;
};
export type QueueAcknowledgement = { id: string; durability: "persistent" | "memory" };
export type QueueState = { pending: number; memoryOnly: number; storageUnavailable: boolean };

let lastMonotonicSeq = 0;
let deviceMode: DeviceTrustMode = "trusted";
let storageUnavailable = false;
const memory = new Map<string, QueuedPortfolioEvent>();
const durable = new Set<string>();
const loadedUsers = new Set<string>();
const listeners = new Set<() => void>();
const flushing = new Map<string, Promise<{ flushed: number; remaining: number }>>();
const keyFor = (uid: string, id: string) => uid + ":" + id;
const changed = () => { for (const listener of listeners) listener(); };

export function configurePortfolioQueue(mode: DeviceTrustMode) { deviceMode = mode; }
export function subscribePortfolioQueue(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function portfolioQueueState(uid: string): QueueState {
  const items = [...memory.values()].filter((item) => item.userId === uid);
  return { pending: items.length, memoryOnly: items.filter((item) => !durable.has(keyFor(uid, item.id))).length, storageUnavailable };
}
/** Owner-side diagnostic only; no symbols, plaintext values or cloud telemetry. */
export function portfolioQueueDiagnostics(uid: string) {
  const items = [...memory.values()].filter(item => item.userId === uid);
  return { ...portfolioQueueState(uid), encryptedBytes: items.reduce((bytes, item) => bytes + new TextEncoder().encode(JSON.stringify(item.event)).length, 0), oldestPendingAt: items.map(item => item.queuedAt).sort()[0] ?? null };
}
export function nextMonotonicTimestamp(): number {
  lastMonotonicSeq = Math.max(Date.now(), lastMonotonicSeq + 1);
  return lastMonotonicSeq;
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, value: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const started = performance.now();
  return withDeadline((async () => {
    const database = await openBrowserDatabase(DATABASE_NAME, 1, (db) => {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("userId_seq", ["userId", "monotonicSeq"], { unique: false });
      }
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = database.transaction(STORE_NAME, mode);
        let result: T;
        const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(new Error("queue_transaction_timeout")); }, Math.max(1, OPTIONAL_STORAGE_TIMEOUT_MS - (performance.now() - started)));
        const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
        tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
        tx.onerror = () => fail(tx.error ?? new Error("queue_transaction_failed"));
        tx.onabort = () => fail(tx.error ?? new Error("queue_transaction_aborted"));
        try { operation(tx.objectStore(STORE_NAME), (value) => { result = value; }, fail); }
        catch (error) { fail(error); }
      });
    } finally { database.close(); }
  })(), OPTIONAL_STORAGE_TIMEOUT_MS, "event-queue");
}

async function load(uid: string) {
  if (loadedUsers.has(uid) || deviceMode !== "trusted" || storageUnavailable) return;
  try {
    const items = await transaction<QueuedPortfolioEvent[]>("readonly", (store, value, fail) => {
      const request = store.getAll();
      request.onsuccess = () => value(request.result ?? []);
      request.onerror = () => fail(request.error);
    });
    for (const item of items) {
      if (item.userId !== uid || item.event?.ownerUid !== uid) continue;
      const key = keyFor(uid, item.id);
      if (!memory.has(key)) memory.set(key, item);
      if (JSON.stringify(memory.get(key)?.event) === JSON.stringify(item.event)) durable.add(key);
    }
    loadedUsers.add(uid);
  } catch { storageUnavailable = true; }
  changed();
}

export async function enqueuePendingPortfolioEvent(userId: string, eventId: string, event: EncryptedPortfolioEvent): Promise<QueueAcknowledgement> {
  if (!userId || event.ownerUid !== userId) throw new Error("queue_owner_mismatch");
  const key = keyFor(userId, eventId);
  const previous = memory.get(key);
  if (previous && JSON.stringify(previous.event) !== JSON.stringify(event)) throw new Error("queue_event_conflict");
  const item = previous ?? { id: eventId, userId, monotonicSeq: nextMonotonicTimestamp(), queuedAt: new Date().toISOString(), event, retryCount: 0 };
  memory.set(key, item);
  changed();
  if (deviceMode === "trusted" && !storageUnavailable) {
    try {
      await transaction<void>("readwrite", (store) => { store.put(item); });
      durable.add(key);
    } catch { storageUnavailable = true; }
  }
  changed();
  return { id: eventId, durability: durable.has(key) ? "persistent" : "memory" };
}

export async function getPendingPortfolioEvents(userId: string): Promise<QueuedPortfolioEvent[]> {
  await load(userId);
  return [...memory.values()].filter((item) => item.userId === userId).sort((a, b) => a.monotonicSeq - b.monotonicSeq || a.id.localeCompare(b.id));
}

export async function removePendingPortfolioEvent(userId: string, eventId: string): Promise<void> {
  const key = keyFor(userId, eventId);
  if (deviceMode === "trusted" && !storageUnavailable) {
    try {
      await transaction<void>("readwrite", (store, _value, fail) => {
        const request = store.get(eventId);
        request.onsuccess = () => { if (request.result?.userId === userId) store.delete(eventId); };
        request.onerror = () => fail(request.error);
      });
    } catch { storageUnavailable = true; }
  }
  memory.delete(key);
  durable.delete(key);
  changed();
}

export async function updatePendingPortfolioEventRetry(userId: string, eventId: string, retryCount: number) {
  const item = memory.get(keyFor(userId, eventId));
  if (!item) return;
  item.retryCount = retryCount;
  item.nextAttemptAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(retryCount - 1, 5));
  if (deviceMode === "trusted" && !storageUnavailable) {
    try { await transaction<void>("readwrite", (store) => { store.put(item); }); }
    catch { storageUnavailable = true; }
  }
  changed();
}

export async function replacePendingPortfolioEvent(userId: string, eventId: string, event: EncryptedPortfolioEvent) {
  await load(userId);
  const key = keyFor(userId, eventId);
  const previous = memory.get(key);
  if (!previous || event.ownerUid !== userId) throw new Error("queue_event_missing");
  memory.set(key, { ...previous, event, retryCount: 0, nextAttemptAt: 0 });
  durable.delete(key);
  await enqueuePendingPortfolioEvent(userId, eventId, event);
}

export async function clearPendingPortfolioEvents(userId: string) {
  const items = await getPendingPortfolioEvents(userId);
  for (const item of items) await removePendingPortfolioEvent(userId, item.id);
}

/** Explicit retry can recover a temporary storage failure without losing the
 * memory adapter's newer encrypted records or requiring the tab to close. */
export async function retryPortfolioQueueStorage(userId: string) {
  if (deviceMode !== "trusted") return;
  storageUnavailable = false;
  loadedUsers.delete(userId);
  await load(userId);
  if (storageUnavailable) return;
  const items = [...memory.values()].filter((item) => item.userId === userId);
  try {
    await transaction<void>("readwrite", (store) => { for (const item of items) store.put(item); });
    for (const item of items) durable.add(keyFor(userId, item.id));
  } catch { storageUnavailable = true; }
  changed();
}

export function flushPendingPortfolioEvents(userId: string, saveFn: (userId: string, eventId: string, event: EncryptedPortfolioEvent) => Promise<void>, force = false): Promise<{ flushed: number; remaining: number }> {
  const existing = flushing.get(userId);
  if (existing) return existing;
  const task = (async () => {
    let flushed = 0;
    const items = await getPendingPortfolioEvents(userId);
    for (const item of items) {
      if (!force && (item.nextAttemptAt ?? 0) > Date.now()) break;
      try {
        await withDeadline(saveFn(userId, item.id, item.event), 10_000, "cloud-save");
        await removePendingPortfolioEvent(userId, item.id);
        flushed++;
      } catch {
        await updatePendingPortfolioEventRetry(userId, item.id, item.retryCount + 1);
        break;
      }
    }
    return { flushed, remaining: (await getPendingPortfolioEvents(userId)).length };
  })().finally(() => flushing.delete(userId));
  flushing.set(userId, task);
  return task;
}

/** Clears volatile state only, for an isolated session/test; never deletes durable events. */
export function resetPortfolioQueueMemory() {
  memory.clear(); durable.clear(); loadedUsers.clear();
  storageUnavailable = false; deviceMode = "trusted";
  changed();
}
