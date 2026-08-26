import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  writeBatch,
  where,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";
import type { EncryptedBlock, KabutoraVaultEnvelope } from "@/lib/vault-crypto";

/**
 * Opaque records intentionally keep the UI independent from Firestore. A future
 * Cloudflare implementation only needs to provide this same small contract.
 */
export type EncryptedPortfolioEvent = {
  ownerUid: string;
  payload: EncryptedBlock;
  keyId?: string;
};

export type StoredPortfolioEvent = EncryptedPortfolioEvent & { id: string };

export type GoogleAccountVaultKey = {
  format: "kabutora-google-account-key";
  version: 1;
  ownerUid: string;
  keyId: string;
  encodedKey: string;
  createdAt: string;
  updatedAt: string;
};

export type PortfolioCloudStore = {
  subscribeVault: (
    userId: string,
    onValue: (value: unknown | null) => void,
    onError: (cause: unknown) => void,
  ) => Unsubscribe;
  saveVault: (userId: string, value: KabutoraVaultEnvelope) => Promise<void>;
  subscribeAccountKey: (
    userId: string,
    onValue: (value: GoogleAccountVaultKey | null) => void,
    onError: (cause: unknown) => void,
  ) => Unsubscribe;
  saveAccountKey: (userId: string, value: GoogleAccountVaultKey) => Promise<void>;
  saveGoogleProtectedVault: (userId: string, envelope: KabutoraVaultEnvelope, key: GoogleAccountVaultKey) => Promise<void>;
  subscribeEvents: (
    userId: string,
    onValue: (events: StoredPortfolioEvent[], fromCache: boolean) => void,
    onError: (cause: unknown) => void,
  ) => Unsubscribe;
  saveEvent: (userId: string, eventId: string, value: EncryptedPortfolioEvent) => Promise<void>;
  deleteAllEvents: (userId: string) => Promise<void>;
};

export const portfolioEventsSnapshotIsReady = (fromCache: boolean, online: boolean) => !fromCache || !online;
export const portfolioEventSnapshotSignature = (events: Array<Pick<StoredPortfolioEvent, "id">>) => events.map((event) => event.id).sort().join("|");

export function createFirebasePortfolioCloudStore(db: Firestore): PortfolioCloudStore {
  return {
    subscribeVault(userId, onValue, onError) {
      return onSnapshot(doc(db, "users", userId, "vaults", "default"), (snapshot) => {
        onValue(snapshot.exists() ? snapshot.data() : null);
      }, onError);
    },
    async saveVault(userId, value) {
      await setDoc(doc(db, "users", userId, "vaults", "default"), value);
    },
    subscribeAccountKey(userId, onValue, onError) {
      return onSnapshot(doc(db, "users", userId, "keys", "google-account"), (snapshot) => {
        onValue(snapshot.exists() ? snapshot.data() as GoogleAccountVaultKey : null);
      }, onError);
    },
    async saveAccountKey(userId, value) {
      await setDoc(doc(db, "users", userId, "keys", "google-account"), value);
    },
    async saveGoogleProtectedVault(userId, envelope, key) {
      const batch = writeBatch(db);
      batch.set(doc(db, "users", userId, "vaults", "default"), envelope);
      batch.set(doc(db, "users", userId, "keys", "google-account"), key);
      await batch.commit();
    },
    subscribeEvents(userId, onValue, onError) {
      const ownedEvents = query(collection(db, "users", userId, "events"), where("ownerUid", "==", userId));
      return onSnapshot(ownedEvents, { includeMetadataChanges: true }, (snapshot) => {
        onValue(snapshot.docs.map((eventDocument) => ({
          id: eventDocument.id,
          ...eventDocument.data(),
        } as StoredPortfolioEvent)), snapshot.metadata.fromCache);
      }, onError);
    },
    async saveEvent(userId, eventId, value) {
      await setDoc(doc(db, "users", userId, "events", eventId), value);
    },
    async deleteAllEvents(userId) {
      const ownedEvents = query(collection(db, "users", userId, "events"), where("ownerUid", "==", userId));
      const snapshot = await getDocs(ownedEvents);
      await Promise.all(snapshot.docs.map((eventDocument) => deleteDoc(eventDocument.ref)));
    },
  };
}
