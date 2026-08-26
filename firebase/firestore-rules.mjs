import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import fs from "node:fs/promises";

const projectId = "demo-kabutora-security-rules";
const ownerUid = "owner-user";
const otherUid = "other-user";
const validBlock = {
  algorithm: "AES-256-GCM",
  iv: "MDEyMzQ1Njc4OWFi",
  ciphertext: "ZW5jcnlwdGVkLXBheWxvYWQ",
};

const environment = await initializeTestEnvironment({
  projectId,
  firestore: {
    rules: await fs.readFile(new URL("./firestore.rules", import.meta.url), "utf8"),
  },
});

try {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "appAccess", ownerUid), {});
    await setDoc(doc(context.firestore(), "appAccess", otherUid), {});
  });

  const owner = environment.authenticatedContext(ownerUid).firestore();
  const other = environment.authenticatedContext(otherUid).firestore();
  const anonymous = environment.unauthenticatedContext().firestore();
  const eventPath = doc(owner, "users", ownerUid, "events", "opaque-event-id");
  const validEvent = { ownerUid, payload: validBlock };
  const vaultPath = doc(owner, "users", ownerUid, "vaults", "default");
  const accountKeyPath = doc(owner, "users", ownerUid, "keys", "google-account");

  await assertSucceeds(getDoc(vaultPath));
  await assertFails(getDoc(doc(other, "users", ownerUid, "vaults", "default")));
  await assertSucceeds(setDoc(eventPath, validEvent));
  await assertSucceeds(getDoc(eventPath));
  await assertSucceeds(getDocs(query(
    collection(owner, "users", ownerUid, "events"),
    where("ownerUid", "==", ownerUid),
  )));
  await assertFails(getDocs(collection(owner, "users", ownerUid, "events")));
  await assertFails(getDoc(doc(other, "users", ownerUid, "events", "opaque-event-id")));
  await assertFails(getDoc(doc(anonymous, "users", ownerUid, "events", "opaque-event-id")));
  await assertFails(setDoc(doc(other, "users", ownerUid, "events", "attacker-event"), {
    ownerUid,
    payload: validBlock,
  }));
  await assertFails(setDoc(doc(owner, "users", ownerUid, "events", "metadata-leak"), {
    ownerUid,
    kind: "transaction",
    createdAt: new Date().toISOString(),
    payload: validBlock,
  }));
  await assertFails(setDoc(doc(owner, "users", ownerUid, "events", "weak-cipher"), {
    ownerUid,
    payload: { algorithm: "PLAINTEXT", iv: "", ciphertext: "portfolio" },
  }));
  await assertFails(updateDoc(eventPath, { payload: { ...validBlock, ciphertext: "changed" } }));
  await assertSucceeds(deleteDoc(eventPath));

  const validVault = {
    format: "kabutora-encrypted-vault",
    version: 1,
    ownerUid,
    kdf: {
      algorithm: "ARGON2ID",
      salt: "MDEyMzQ1Njc4OWFiY2RlZg",
      memoryKiB: 65536,
      iterations: 3,
      parallelism: 1,
    },
    wrappedKey: validBlock,
    recoveryWrappedKey: validBlock,
    payload: validBlock,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await assertSucceeds(setDoc(vaultPath, validVault));
  await assertFails(setDoc(doc(other, "users", ownerUid, "vaults", "default"), validVault));
  await assertFails(setDoc(vaultPath, {
    ...validVault,
    kdf: { ...validVault.kdf, memoryKiB: 1024, iterations: 1 },
  }));

  const validAccountKey = {
    format: "kabutora-google-account-key",
    version: 1,
    ownerUid,
    keyId: "01234567-89ab-cdef-0123-456789abcdef",
    encodedKey: "0123456789012345678901234567890123456789012",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await assertSucceeds(getDoc(accountKeyPath));
  await assertSucceeds(setDoc(accountKeyPath, validAccountKey));
  await assertFails(getDoc(doc(other, "users", ownerUid, "keys", "google-account")));
  await assertFails(getDocs(collection(owner, "users", ownerUid, "keys")));
  await assertFails(setDoc(doc(other, "users", ownerUid, "keys", "google-account"), validAccountKey));
  await assertFails(setDoc(accountKeyPath, { ...validAccountKey, encodedKey: "short" }));

  console.log("Firestore security rules: 22 authorization and validation checks passed");
} finally {
  await environment.cleanup();
}
