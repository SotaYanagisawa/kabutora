import { describe, expect, it } from "vitest";
import {
  createEncryptedVault,
  createGoogleProtectedVault,
  decryptVaultWithDataKey,
  isKabutoraVaultEnvelope,
  importGoogleAccountKey,
  serializeVault,
  unlockVaultWithPassphrase,
  unlockVaultWithRecoveryKey,
  updateEncryptedVault,
} from "./vault-crypto";

const fixture = {
  portfolio: { id: "portfolio-1", name: "Test" },
  transactions: [{ id: "tx-1", symbol: "7203", quantity: "100", price: "2500" }],
};

describe("encrypted vault", () => {
  it("encrypts data without leaving plaintext in the envelope", async () => {
    const created = await createEncryptedVault(fixture, "correct horse battery staple");
    const serialized = serializeVault(created.envelope);
    expect(serialized).not.toContain("7203");
    expect(serialized).not.toContain("2500");
    expect(isKabutoraVaultEnvelope(JSON.parse(serialized))).toBe(true);
    expect((await unlockVaultWithPassphrase<typeof fixture>(created.envelope, "correct horse battery staple")).data).toEqual(fixture);
  });

  it("unlocks with the offline recovery key", async () => {
    const created = await createEncryptedVault(fixture, "a different long passphrase");
    expect((await unlockVaultWithRecoveryKey<typeof fixture>(created.envelope, created.recoveryKey)).data).toEqual(fixture);
  });

  it("rejects an incorrect passphrase", async () => {
    const created = await createEncryptedVault(fixture, "correct horse battery staple");
    await expect(unlockVaultWithPassphrase(created.envelope, "this passphrase is incorrect")).rejects.toThrow("復号できませんでした");
  });

  it("rotates the payload IV and increments the revision", async () => {
    const created = await createEncryptedVault(fixture, "correct horse battery staple");
    const nextData = { ...fixture, transactions: [...fixture.transactions, { id: "tx-2", symbol: "AAPL", quantity: "2", price: "210" }] };
    const updated = await updateEncryptedVault(created.envelope, created.dataKey, nextData);
    expect(updated.revision).toBe(2);
    expect(updated.payload.iv).not.toBe(created.envelope.payload.iv);
    expect(await decryptVaultWithDataKey<typeof nextData>(updated, created.dataKey)).toEqual(nextData);
    expect((await unlockVaultWithPassphrase<typeof nextData>(updated, "correct horse battery staple")).data).toEqual(nextData);
  });

  it("opens a Google-protected cloud vault with its account key", async () => {
    const created = await createGoogleProtectedVault(fixture, "owner-user");
    const accountKey = await importGoogleAccountKey(created.accountKey);
    expect(await decryptVaultWithDataKey<typeof fixture>(created.envelope, accountKey)).toEqual(fixture);
    await expect(importGoogleAccountKey("invalid")).rejects.toThrow("Googleアカウント鍵");
  });
});
