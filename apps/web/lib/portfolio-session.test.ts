import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import demo from "../data/demo-seed.json";
import { PortfolioSession, type SessionState } from "./portfolio-session";
import { createEncryptedVault, createGoogleProtectedVault, createRecoveryVault, decryptVaultWithDataKey, encryptVaultRecord, type KabutoraVaultEnvelope } from "./vault-crypto";
import { enqueuePendingPortfolioEvent, getPendingPortfolioEvents, resetPortfolioQueueMemory, configurePortfolioQueue } from "./portfolio-offline-queue";
import type { PortfolioCloudStore, StoredPortfolioEvent } from "./portfolio-cloud-store";
import { validatePortfolio } from "./portfolio-validation";
import { loadVerifiedRecoveryDraft, saveVerifiedRecoveryDraft, loadTrustedDeviceKey } from "./trusted-device-key-store";
import { readVerifiedVault } from "./verified-vault-cache";

vi.mock("./trusted-device-key-store", () => ({ loadTrustedDeviceKey: vi.fn(async () => { throw new Error("IndexedDB unavailable"); }), saveTrustedDeviceKey: vi.fn(async () => {}), loadVerifiedRecoveryDraft: vi.fn(async () => null), saveVerifiedRecoveryDraft: vi.fn(async () => {}), clearVerifiedRecoveryDraft: vi.fn(async () => {}) }));
vi.mock("./verified-vault-cache", () => ({ readVerifiedVault: vi.fn(async () => undefined), saveVerifiedVault: vi.fn(async () => {}) }));
const seed = validatePortfolio(demo);
const passphrase = "synthetic recovery passphrase only";
let legacy: Awaited<ReturnType<typeof createGoogleProtectedVault>>;
let modern: Awaited<ReturnType<typeof createRecoveryVault>>;
const sessions: PortfolioSession[] = [];

function fixture(envelope: KabutoraVaultEnvelope | null, events: StoredPortfolioEvent[] = [], keyRecord = false, mode: "trusted" | "shared" = "shared", stalled = false) {
  let vault = envelope;
  let deltas = events;
  let vaultListener: Parameters<PortfolioCloudStore["subscribeVault"]>[1];
  let eventListener: Parameters<PortfolioCloudStore["subscribeEvents"]>[1];
  const saved: StoredPortfolioEvent[] = [];
  const receipts = new Set<string>();
  const store: PortfolioCloudStore = {
    subscribeVault: (_uid, listener) => { vaultListener = listener; if (!stalled) queueMicrotask(() => listener(vault, false)); return () => {}; },
    subscribeEvents: (_uid, listener) => { eventListener = listener; queueMicrotask(() => listener(deltas, false)); return () => {}; },
    subscribeAccountKey: (_uid, listener) => { queueMicrotask(() => listener(keyRecord ? { format: "kabutora-google-account-key", version: 1, ownerUid: "u1", keyId: "old-key", encodedKey: legacy.accountKey, createdAt: "", updatedAt: "" } : null)); return () => {}; },
    saveAccountKey: vi.fn(async () => {}),
    saveVault: vi.fn(async () => {}),
    saveGoogleProtectedVault: vi.fn(async () => {}),
    saveEvent: async (_uid, id, event) => {
      if (receipts.has(id)) return;
      if (vault?.version === 2 && event.keyId !== vault.keyId) throw new Error("obsolete");
      saved.push({ id, ...event }); deltas = [...deltas, { id, ...event }]; eventListener(deltas, false);
    },
    acquireWriteLock: vi.fn(async () => ({ token: "lock", expiresAt: Date.now() + 90_000 })),
    releaseWriteLock: vi.fn(async () => {}),
    readForMigration: async () => ({ envelope: vault, events: deltas }),
    activateGeneration: vi.fn(async (_uid, _lease, next, expected) => { if ((vault?.revision ?? 0) !== expected) throw new Error("conflict"); vault = next; vaultListener(next, false); }),
    compactVaultWithEvents: vi.fn(async () => {}),
    cleanupIncorporatedEvents: async (_uid, _envelope, ids) => { for (const id of ids) receipts.add(id); deltas = deltas.filter((event) => !receipts.has(event.id)); eventListener(deltas, false); },
  };
  let state: SessionState | undefined;
  let current = true;
  const session = new PortfolioSession("u1", mode, store, (value) => { state = value; }, () => current);
  sessions.push(session); session.start();
  return { session, store, saved, switchAccount: () => { current = false; }, get state() { return state; }, get envelope() { return vault; }, emitVault: () => vaultListener(vault, false), emitEvents: (events:StoredPortfolioEvent[]) => { deltas=events;eventListener(deltas,false); } };
}
beforeAll(async () => {
  legacy = await createGoogleProtectedVault(seed, "u1");
  modern = await createRecoveryVault(seed, passphrase, "u1", { "old-key": legacy.accountKey });
});
beforeEach(() => { resetPortfolioQueueMemory(); configurePortfolioQueue("shared"); vi.clearAllMocks(); vi.mocked(readVerifiedVault).mockResolvedValue(undefined); vi.mocked(loadVerifiedRecoveryDraft).mockResolvedValue(null); vi.mocked(loadTrustedDeviceKey).mockRejectedValue(new Error("IndexedDB unavailable")); });
afterEach(() => { for (const session of sessions.splice(0)) session.stop(); resetPortfolioQueueMemory(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("encrypted cloud startup and recovery", () => {
  it("keeps the repairs release usable with legacy vaults and compatible with migrated generations", async () => {
    vi.stubEnv("NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION", "deferred");
    const legacyApp = fixture(legacy.envelope, [], true);
    await vi.waitFor(() => expect(legacyApp.state?.startup.stage).toBe("ready"));
    await legacyApp.session.save([{ kind: "preferences", value: { theme: "dark" } }]);
    await vi.waitFor(() => expect(legacyApp.saved).toHaveLength(1));
    legacyApp.session.stop();
    const migrated = fixture(modern.envelope);
    await vi.waitFor(() => expect(migrated.state?.needsUnlock).toBe(true));
    await migrated.session.unlock(modern.recoveryKey, "recovery");
    await vi.waitFor(() => expect(migrated.state?.startup.stage).toBe("ready"));
    expect(migrated.state?.seed?.transactions).toEqual(seed.transactions);
  });
  it("identifies a stalled startup stage after fifteen seconds without publishing an empty portfolio", async () => {
    vi.useFakeTimers();
    const app = fixture(modern.envelope, [], false, "shared", true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(app.state?.startup).toMatchObject({ stage: "recoverable-error", failedStage: "vault" });
    expect(app.state?.seed).toBeNull();
  });
  it("opens only a previously verified encrypted snapshot and marks cloud changes unconfirmed", async () => {
    vi.useFakeTimers();
    vi.mocked(readVerifiedVault).mockResolvedValue({ uid: "u1", envelope: modern.envelope, verifiedAt: "2026-09-01T00:00:00Z" });
    vi.mocked(loadTrustedDeviceKey).mockResolvedValue(modern.dataKey);
    const app = fixture(modern.envelope, [], false, "trusted", true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(app.state?.cachedAvailable).toBe(true);
    await app.session.openCached();
    expect(app.state).toMatchObject({ cached: true, startup: { stage: "ready" } });
    expect(app.state?.seed?.transactions).toEqual(seed.transactions);
    expect(app.state?.warning).toContain("未確認");
    await app.session.save([{ kind: "preferences", value: { theme: "dark" } }]);
    expect(app.saved).toEqual([]);
    expect(await getPendingPortfolioEvents("u1")).toHaveLength(1);
  });
  it("asks for recovery on a new v2 device, then waits for verified replay before ready", async () => {
    const app = fixture(modern.envelope);
    await vi.waitFor(() => expect(app.state?.needsUnlock).toBe(true));
    expect(app.state?.seed).toBeNull();
    await app.session.unlock(modern.recoveryKey, "recovery");
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("ready"));
    expect(app.state?.seed?.transactions).toEqual(seed.transactions);
  });
  it("migrates only after local recovery verification, preserving encrypted pending changes", async () => {
    vi.stubEnv("NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION", "enabled");
    const account = { ...seed.accounts[0]!, name: "offline account edit", version: 2, updatedAt: "2026-09-01T00:00:00Z" };
    await enqueuePendingPortfolioEvent("u1", "pending", { ownerUid: "u1", keyId: "old-key", payload: await encryptVaultRecord(legacy.dataKey, { kind: "account", value: account, clientSeq: Date.parse(account.updatedAt) }) });
    const app = fixture(legacy.envelope, [], true);
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("enrollment"));
    const prepared = await app.session.prepareRecovery(passphrase);
    await expect(app.session.activateRecovery(prepared, modern.recoveryKey)).rejects.toThrow();
    expect(app.store.acquireWriteLock).not.toHaveBeenCalled();
    await app.session.activateRecovery(prepared, prepared.recoveryKey);
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("ready"));
    expect(app.envelope?.version).toBe(2);
    const restored = validatePortfolio(await decryptVaultWithDataKey(app.envelope!, prepared.dataKey));
    expect(restored.accounts.find((value) => value.id === account.id)?.name).toBe("offline account edit");
    expect(JSON.stringify(app.envelope)).not.toContain(legacy.accountKey);
    await vi.waitFor(async () => expect(await getPendingPortfolioEvents("u1")).toEqual([]));
  });
  it("converts an offline old-generation event after enrollment without discarding it", async () => {
    const event = { kind: "preferences", value: { theme: "dark" }, clientSeq: 2000 };
    await enqueuePendingPortfolioEvent("u1", "offline-old", { ownerUid: "u1", keyId: "old-key", payload: await encryptVaultRecord(legacy.dataKey, event) });
    const app = fixture(modern.envelope);
    await vi.waitFor(() => expect(app.state?.needsUnlock).toBe(true));
    await app.session.unlock(modern.recoveryKey, "recovery");
    await vi.waitFor(() => expect(app.saved).toHaveLength(1));
    expect(app.saved[0]!.id).toBe("offline-old");
    expect(app.saved[0]!.keyId).toBe(modern.envelope.keyId);
    expect(app.state?.seed?.preferences?.theme).toBe("dark");
  });
  it("supports importing a legacy passphrase backup into an empty account", async () => {
    const backup = await createEncryptedVault(seed, passphrase);
    const app = fixture(null);
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("empty"));
    await app.session.unlock(backup.recoveryKey, "recovery", backup.envelope);
    expect(app.state?.startup.stage).toBe("enrollment");
    const prepared = await app.session.prepareRecovery(passphrase);
    await app.session.activateRecovery(prepared, prepared.recoveryKey);
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("ready"));
    expect(app.state?.seed?.transactions).toEqual(seed.transactions);
  });
  it("resumes a locally verified generation after interrupted activation", async () => {
    vi.stubEnv("NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION", "enabled");
    const first = fixture(legacy.envelope, [], true, "trusted");
    await vi.waitFor(() => expect(first.state?.startup.stage).toBe("enrollment"));
    const prepared = await first.session.prepareRecovery(passphrase);
    vi.mocked(first.store.activateGeneration).mockRejectedValueOnce(new Error("connection_lost"));
    await expect(first.session.activateRecovery(prepared, prepared.recoveryKey)).rejects.toThrow("connection_lost");
    expect(saveVerifiedRecoveryDraft).toHaveBeenCalledWith("u1", "old-key", prepared.envelope, prepared.dataKey);
    first.session.stop();
    vi.mocked(loadVerifiedRecoveryDraft).mockResolvedValue({ id: "draft", uid: "u1", version: 2, previousGeneration: "old-key", envelope: prepared.envelope, key: prepared.dataKey, savedAt: "2026-09-01" });
    const resumed = fixture(legacy.envelope, [], true, "trusted");
    await vi.waitFor(() => expect(resumed.state?.recoveryPending).toBe(true));
    await resumed.session.resumeRecovery();
    await vi.waitFor(() => expect(resumed.state?.startup.stage).toBe("ready"));
    expect(resumed.envelope?.keyId).toBe(prepared.envelope.keyId);
    expect(resumed.state?.seed?.transactions).toEqual(seed.transactions);
  });
  it("never publishes or saves through a session after account switching", async () => {
    const app = fixture(modern.envelope);
    await vi.waitFor(() => expect(app.state?.needsUnlock).toBe(true));
    app.switchAccount();
    await app.session.unlock(modern.recoveryKey, "recovery");
    expect(app.state?.seed).toBeNull();
    await expect(app.session.save([{ kind: "preferences", value: { theme: "dark" } }])).rejects.toThrow();
    expect(app.saved).toEqual([]);
  });
  it("authenticates and unlocks directly with Google account key without passphrase or recovery key", async () => {
    const app = fixture(legacy.envelope, [], true);
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("ready"));
    expect(app.state?.needsUnlock).toBe(false);
    expect(app.state?.seed?.transactions).toEqual(seed.transactions);
    expect(app.state?.seed?.accounts).toEqual(seed.accounts);
  });
  it("never uploads a data key or rotates a trusted recovery vault during replay", async () => {
    vi.mocked(loadTrustedDeviceKey).mockResolvedValue(modern.dataKey);
    const app = fixture(modern.envelope, [], false, "trusted");
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("ready"));
    await app.session.flush();
    expect(app.store.saveAccountKey).not.toHaveBeenCalled();
    expect(app.store.saveGoogleProtectedVault).not.toHaveBeenCalled();
    expect(app.state?.envelope).toEqual(modern.envelope);
    expect(await decryptVaultWithDataKey(app.state!.envelope!, modern.dataKey)).toMatchObject({ transactions: seed.transactions });
  });
  it("does not publish the raw key after recovery unlock", async () => {
    const app = fixture(modern.envelope);
    await vi.waitFor(() => expect(app.state?.needsUnlock).toBe(true));
    await app.session.unlock(modern.recoveryKey, "recovery");
    await vi.waitFor(() => expect(app.state?.startup.stage).toBe("ready"));
    await app.session.flush();
    expect(app.store.saveAccountKey).not.toHaveBeenCalled();
    expect(app.store.saveGoogleProtectedVault).not.toHaveBeenCalled();
  });
  it("keeps backup enrollment and the original cloud key through live snapshots, preserving concurrent edits", async () => {
    const app=fixture(modern.envelope);
    await vi.waitFor(()=>expect(app.state?.needsUnlock).toBe(true));
    await app.session.unlock(modern.recoveryKey,"recovery");
    await vi.waitFor(()=>expect(app.state?.startup.stage).toBe("ready"));
    const restored={...seed,accounts:seed.accounts.map(account=>({...account,name:account.name+" restored"}))};
    const backup=await createEncryptedVault(restored,passphrase,"u1");
    await app.session.unlock(backup.recoveryKey,"recovery",backup.envelope);
    const payload={kind:"preferences" as const,value:{theme:"dark" as const},clientSeq:Date.now(),clientTimestamp:new Date().toISOString()};
    app.emitEvents([{id:"concurrent-edit",ownerUid:"u1",keyId:modern.envelope.keyId,payload:await encryptVaultRecord(modern.dataKey,payload)}]);
    app.emitVault();
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(app.state?.startup.stage).toBe("enrollment");
    expect(app.state?.seed?.accounts).toEqual(restored.accounts);
    const prepared=await app.session.prepareRecovery(passphrase);
    await app.session.activateRecovery(prepared,prepared.recoveryKey);
    await vi.waitFor(()=>expect(app.state?.startup.stage).toBe("ready"));
    const decoded=validatePortfolio(await decryptVaultWithDataKey(app.envelope!,prepared.dataKey));
    expect(decoded.accounts).toEqual(restored.accounts);
    expect(decoded.preferences?.theme).toBe("dark");
  });
  it("allows importing and restoring a backup even when the cloud vault is initially locked", async () => {
    const app = fixture(modern.envelope);
    await vi.waitFor(() => expect(app.state?.needsUnlock).toBe(true));
    // Create an encrypted backup
    const backup = await createEncryptedVault(seed, "temporary-backup-passphrase-16chars", "u1");
    // Unlock using the backup envelope
    await app.session.unlock("temporary-backup-passphrase-16chars", "passphrase", backup.envelope);
    expect(app.state?.needsUnlock).toBe(false);
    expect(app.state?.seed?.transactions).toEqual(seed.transactions);
  });
});
