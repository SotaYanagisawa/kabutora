import {
  collection, doc, getDocFromServer, getDocsFromServer, onSnapshot, query, runTransaction, where,
  type Firestore, type Unsubscribe,
} from "firebase/firestore";
import { isKabutoraVaultEnvelope, type EncryptedBlock, type KabutoraVaultEnvelope } from "./vault-crypto";
import { withDeadline } from "./operation-deadline";

export type EncryptedPortfolioEvent = { ownerUid: string; payload: EncryptedBlock; keyId?: string };
export type StoredPortfolioEvent = EncryptedPortfolioEvent & { id: string };
/** Read only compatibility with previously deployed vaults. Never written by this client. */
export type GoogleAccountVaultKey = {
  format: "kabutora-google-account-key"; version: 1; ownerUid: string; keyId: string;
  encodedKey: string; createdAt: string; updatedAt: string;
};
export type VaultLease = { token: string; expiresAt: number };
type VaultControl = { ownerUid: string; generation: string; lockToken: string | null; lockUntil: number; committedToken?: string };
export type PortfolioCloudStore = {
  subscribeVault: (uid: string, value: (value: unknown | null, fromCache: boolean) => void, error: (cause: unknown) => void) => Unsubscribe;
  subscribeAccountKey: (uid: string, value: (value: GoogleAccountVaultKey | null) => void, error: (cause: unknown) => void) => Unsubscribe;
  subscribeEvents: (uid: string, value: (events: StoredPortfolioEvent[], fromCache: boolean) => void, error: (cause: unknown) => void) => Unsubscribe;
  saveEvent: (uid: string, id: string, value: EncryptedPortfolioEvent) => Promise<void>;
  acquireWriteLock: (uid: string, expectedRevision: number) => Promise<VaultLease>;
  releaseWriteLock: (uid: string, lease: VaultLease) => Promise<void>;
  readForMigration: (uid: string, lease: VaultLease) => Promise<{ envelope: KabutoraVaultEnvelope | null; events: StoredPortfolioEvent[] }>;
  activateGeneration: (uid: string, lease: VaultLease, envelope: KabutoraVaultEnvelope, expectedRevision: number) => Promise<void>;
  compactVaultWithEvents: (uid: string, envelope: KabutoraVaultEnvelope, eventIds: string[]) => Promise<void>;
  cleanupIncorporatedEvents: (uid: string, envelope: KabutoraVaultEnvelope, eventIds: string[]) => Promise<void>;
};
export const PORTFOLIO_EVENT_COMPACTION_THRESHOLD = 40;
export const portfolioEventsSnapshotIsReady = (fromCache: boolean, online: boolean) => !fromCache || !online;
export const portfolioEventSnapshotSignature = (events: Array<Pick<StoredPortfolioEvent, "id">>) => events.map((event) => event.id).sort().join("|");
const generation = (vault?: KabutoraVaultEnvelope | null) => vault?.version === 2 ? vault.keyId! : "legacy";
const unlocked = (control?: VaultControl) => !control?.lockToken || control.lockUntil <= Date.now();
const assertLease = (control: VaultControl | undefined, lease: VaultLease) => {
  if (!control || control.lockToken !== lease.token || control.lockUntil <= Date.now()) throw new Error("vault_migration_lock_expired");
};
const deadline = <T>(promise: Promise<T>) => withDeadline(promise, 15_000, "cloud-sync");

export function createFirebasePortfolioCloudStore(db: Firestore): PortfolioCloudStore {
  const vaultRef = (uid: string) => doc(db, "users", uid, "vaults", "default");
  const controlRef = (uid: string) => doc(db, "users", uid, "control", "vault");
  const eventsQuery = (uid: string) => query(collection(db, "users", uid, "events"), where("ownerUid", "==", uid));
  const store: PortfolioCloudStore = {
    subscribeVault(uid, value, error) {
      return onSnapshot(vaultRef(uid), { includeMetadataChanges: true }, (snapshot) => value(snapshot.exists() ? snapshot.data() : null, snapshot.metadata.fromCache), error);
    },
    subscribeAccountKey(uid, value, error) {
      return onSnapshot(doc(db, "users", uid, "keys", "google-account"), (snapshot) => value(snapshot.exists() ? snapshot.data() as GoogleAccountVaultKey : null), error);
    },
    subscribeEvents(uid, value, error) {
      return onSnapshot(eventsQuery(uid), { includeMetadataChanges: true }, (snapshot) => value(snapshot.docs.map((item) => ({ ...item.data(), id: item.id } as StoredPortfolioEvent)), snapshot.metadata.fromCache), error);
    },
    async saveEvent(uid, id, value) {
      if (value.ownerUid !== uid) throw new Error("event_owner_mismatch");
      await deadline(runTransaction(db, async (transaction) => {
        const eventRef = doc(db, "users", uid, "events", id);
        const [receipt, existing, vault, control] = await Promise.all([
          transaction.get(doc(db, "users", uid, "receipts", id)), transaction.get(eventRef),
          transaction.get(vaultRef(uid)), transaction.get(controlRef(uid)),
        ]);
        if (receipt.exists()) return;
        if (existing.exists()) {
          const old = existing.data() as EncryptedPortfolioEvent;
          if (old.ownerUid === uid && old.keyId === value.keyId && old.payload.iv === value.payload.iv && old.payload.ciphertext === value.payload.ciphertext) return;
          throw new Error("event_id_conflict");
        }
        if (!unlocked(control.data() as VaultControl | undefined)) throw new Error("vault_migration_in_progress");
        const envelope = vault.data() as KabutoraVaultEnvelope | undefined;
        if (envelope?.version === 2 && value.keyId !== envelope.keyId) throw new Error("vault_generation_obsolete");
        transaction.set(eventRef, value);
      }));
    },
    async acquireWriteLock(uid, expectedRevision) {
      const lease = { token: crypto.randomUUID(), expiresAt: Date.now() + 90_000 };
      await deadline(runTransaction(db, async (transaction) => {
        const [vault, control] = await Promise.all([transaction.get(vaultRef(uid)), transaction.get(controlRef(uid))]);
        const envelope = vault.data() as KabutoraVaultEnvelope | undefined;
        if ((envelope?.revision ?? 0) !== expectedRevision) throw new Error("vault_revision_changed");
        if (!unlocked(control.data() as VaultControl | undefined)) throw new Error("vault_migration_in_progress");
        transaction.set(controlRef(uid), { ownerUid: uid, generation: generation(envelope), lockToken: lease.token, lockUntil: lease.expiresAt } satisfies VaultControl);
      }));
      return lease;
    },
    async releaseWriteLock(uid, lease) {
      await deadline(runTransaction(db, async (transaction) => {
        const control = await transaction.get(controlRef(uid));
        const value = control.data() as VaultControl | undefined;
        if (value?.lockToken !== lease.token) return;
        transaction.set(controlRef(uid), { ...value, lockToken: null, lockUntil: 0, committedToken: lease.token });
      }));
    },
    async readForMigration(uid, lease) {
      const [vault, events, control] = await deadline(Promise.all([getDocFromServer(vaultRef(uid)), getDocsFromServer(eventsQuery(uid)), getDocFromServer(controlRef(uid))]));
      assertLease(control.data() as VaultControl | undefined, lease);
      const envelope = vault.exists() ? vault.data() : null;
      if (envelope && !isKabutoraVaultEnvelope(envelope)) throw new Error("vault_format_invalid");
      return { envelope, events: events.docs.map((item) => ({ ...item.data(), id: item.id } as StoredPortfolioEvent)) };
    },
    async activateGeneration(uid, lease, envelope, expectedRevision) {
      if (envelope.version !== 2 || envelope.ownerUid !== uid || !envelope.keyId || envelope.revision !== expectedRevision + 1) throw new Error("vault_generation_invalid");
      await deadline(runTransaction(db, async (transaction) => {
        const [vault, control] = await Promise.all([transaction.get(vaultRef(uid)), transaction.get(controlRef(uid))]);
        assertLease(control.data() as VaultControl | undefined, lease);
        if ((vault.data()?.revision ?? 0) !== expectedRevision) throw new Error("vault_revision_changed");
        transaction.set(vaultRef(uid), envelope);
        transaction.set(controlRef(uid), { ownerUid: uid, generation: envelope.keyId!, lockToken: null, lockUntil: 0, committedToken: lease.token } satisfies VaultControl);
        transaction.delete(doc(db, "users", uid, "keys", "google-account"));
      }));
    },
    async compactVaultWithEvents(uid, envelope, eventIds) {
      await deadline(runTransaction(db, async (transaction) => {
        const [vault, control] = await Promise.all([transaction.get(vaultRef(uid)), transaction.get(controlRef(uid))]);
        const existing = vault.data() as KabutoraVaultEnvelope | undefined;
        if (!unlocked(control.data() as VaultControl | undefined)) throw new Error("vault_migration_in_progress");
        if (!existing || generation(existing) !== generation(envelope) || existing.revision + 1 !== envelope.revision) throw new Error("vault_revision_changed");
        transaction.set(vaultRef(uid), envelope);
      }));
      await store.cleanupIncorporatedEvents(uid, envelope, eventIds);
    },
    async cleanupIncorporatedEvents(uid, envelope, eventIds) {
      // Each receipt permanently acknowledges one immutable event. Interrupted
      // cleanup can safely resume because the encrypted snapshot checkpoints IDs.
      for (let offset = 0; offset < eventIds.length; offset += 200) {
        const chunk = eventIds.slice(offset, offset + 200);
        await deadline(runTransaction(db, async (transaction) => {
          const [vault, control] = await Promise.all([transaction.get(vaultRef(uid)), transaction.get(controlRef(uid))]);
          const existing = vault.data() as KabutoraVaultEnvelope | undefined;
          if (!unlocked(control.data() as VaultControl | undefined) || !existing || generation(existing) !== generation(envelope) || existing.revision < envelope.revision) throw new Error("vault_revision_changed");
          for (const id of chunk) {
            transaction.set(doc(db, "users", uid, "receipts", id), { ownerUid: uid, generation: generation(envelope), revision: envelope.revision });
            transaction.delete(doc(db, "users", uid, "events", id));
          }
        }));
      }
    },
  };
  return store;
}
