import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, deleteDoc, where, writeBatch } from "firebase/firestore";
import fs from "node:fs/promises";
const projectId = "demo-kabutora-security-rules";
const uid = "owner-user";
const otherUid = "other-user";
const block = { algorithm: "AES-256-GCM", iv: "MDEyMzQ1Njc4OWFi", ciphertext: "ZW5jcnlwdGVkLXBheWxvYWQ" };
let checks = 0;
const ok = async (task) => { await assertSucceeds(task); checks++; };
const no = async (task) => { await assertFails(task); checks++; };
const environment = await initializeTestEnvironment({ projectId, firestore: { rules: await fs.readFile(new URL("./firestore.rules", import.meta.url), "utf8") } });
try {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "appAccess", uid), {});
    await setDoc(doc(context.firestore(), "appAccess", otherUid), {});
  });
  const db = environment.authenticatedContext(uid).firestore();
  const other = environment.authenticatedContext(otherUid).firestore();
  const anon = environment.unauthenticatedContext().firestore();
  const vault = doc(db, "users", uid, "vaults", "default");
  const key = doc(db, "users", uid, "keys", "google-account");
  const control = doc(db, "users", uid, "control", "vault");
  const event = doc(db, "users", uid, "events", "event-1");
  const legacy = {
    format: "kabutora-encrypted-vault", version: 1, ownerUid: uid,
    kdf: { algorithm: "ARGON2ID", salt: "MDEyMzQ1Njc4OWFiY2RlZg", memoryKiB: 65536, iterations: 3, parallelism: 1 },
    wrappedKey: block, recoveryWrappedKey: block, payload: block, revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const legacyKey = { format: "kabutora-google-account-key", version: 1, ownerUid: uid, keyId: "01234567-89ab-cdef-0123-456789abcdef", encodedKey: "0123456789012345678901234567890123456789012", createdAt: "", updatedAt: "" };
  await ok(getDoc(vault));
  await no(getDoc(doc(other, "users", uid, "vaults", "default")));
  await no(getDoc(doc(anon, "users", uid, "vaults", "default")));
  await no(setDoc(vault, legacy));
  await ok(setDoc(key, legacyKey));
  await no(setDoc(doc(other, "users", uid, "keys", "google-account"), legacyKey));
  await no(setDoc(key, { ...legacyKey, encodedKey: "short" }));
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "users", uid, "vaults", "default"), legacy);
    await setDoc(doc(context.firestore(), "users", uid, "keys", "google-account"), legacyKey);
  });
  await ok(getDoc(key));
  await no(getDocs(collection(db, "users", uid, "keys")));
  await no(getDoc(doc(other, "users", uid, "keys", "google-account")));
  await ok(setDoc(event, { ownerUid: uid, payload: block }));
  await ok(getDoc(doc(db, "users", uid, "events", "missing-event")));
  await ok(getDocs(query(collection(db, "users", uid, "events"), where("ownerUid", "==", uid))));
  await no(getDocs(collection(db, "users", uid, "events")));
  await no(updateDoc(event, { payload: block }));
  await no(deleteDoc(event));
  await no(setDoc(doc(db, "users", uid, "events", "plaintext"), { ownerUid: uid, quantity: "100", payload: block }));
  await no(setDoc(doc(db, "users", uid, "events", "weak"), { ownerUid: uid, payload: { ...block, algorithm: "PLAINTEXT" } }));
  await no(setDoc(vault, { ...legacy, revision: 2, kdf: { ...legacy.kdf, iterations: 999 } }));
  const token = "01234567-89ab-cdef-0123-456789abcdef";
  await ok(setDoc(control, { ownerUid: uid, generation: "legacy", lockToken: token, lockUntil: Date.now() + 90_000 }));
  await no(setDoc(doc(db, "users", uid, "events", "while-locked"), { ownerUid: uid, payload: block }));
  await no(setDoc(vault, { ...legacy, revision: 2 }));
  const next = { ...legacy, version: 2, revision: 2, keyId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", legacyKeys: block };
  await no(setDoc(vault, next));
  const activation = writeBatch(db);
  activation.set(vault, next);
  activation.set(control, { ownerUid: uid, generation: next.keyId, lockToken: null, lockUntil: 0, committedToken: token });
  activation.delete(key);
  await ok(activation.commit());
  await ok(getDoc(vault));
  if ((await getDoc(key)).exists()) throw new Error("raw_key_was_not_removed");
  checks++;
  await ok(setDoc(key, { ...legacyKey, keyId: next.keyId }));
  await no(setDoc(vault, { ...legacy, revision: 3 }));
  await no(setDoc(doc(db, "users", uid, "events", "old-generation"), { ownerUid: uid, keyId: legacyKey.keyId, payload: block }));
  await ok(setDoc(doc(db, "users", uid, "events", "new-generation"), { ownerUid: uid, keyId: next.keyId, payload: block }));
  await ok(setDoc(vault, { ...next, revision: 3 }));
  await no(setDoc(vault, { ...next, revision: 3 }));
  const cleanup = writeBatch(db);
  cleanup.set(doc(db, "users", uid, "receipts", "event-1"), { ownerUid: uid, generation: next.keyId, revision: 3 });
  cleanup.delete(event);
  await ok(cleanup.commit());
  await no(setDoc(event, { ownerUid: uid, keyId: next.keyId, payload: block }));
  await no(setDoc(doc(db, "users", uid, "receipts", "plaintext"), { ownerUid: uid, generation: next.keyId, revision: 3, balance: "1000" }));
  await no(deleteDoc(vault));
  console.log(`Firestore security rules: ${checks} authorization, generation, lock, privacy and compaction checks passed`);
} finally { await environment.cleanup(); }
