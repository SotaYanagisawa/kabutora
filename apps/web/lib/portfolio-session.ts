import type { Seed } from "@/components/dashboard/types";
import type { DeviceTrustMode } from "./firebase-config";
import { type PortfolioCloudStore, type StoredPortfolioEvent, type GoogleAccountVaultKey, PORTFOLIO_EVENT_COMPACTION_THRESHOLD } from "./portfolio-cloud-store";
import { createGoogleProtectedVault, createRecoveryVault, decryptVaultRecord, decryptVaultWithDataKey, encryptVaultRecord, importGoogleAccountKey, isKabutoraVaultEnvelope, readLegacyVaultKeys, unlockVaultWithPassphrase, unlockVaultWithRecoveryKey, updateEncryptedVault, type KabutoraVaultEnvelope } from "./vault-crypto";
import { loadTrustedDeviceKey, saveTrustedDeviceKey, loadVerifiedRecoveryDraft, saveVerifiedRecoveryDraft, clearVerifiedRecoveryDraft, type VerifiedRecoveryDraft } from "./trusted-device-key-store";
import { configurePortfolioQueue, enqueuePendingPortfolioEvent, flushPendingPortfolioEvents, getPendingPortfolioEvents, nextMonotonicTimestamp, replacePendingPortfolioEvent, retryPortfolioQueueStorage } from "./portfolio-offline-queue";
import { replayPortfolioEvents, validatePortfolioEvent, type DecryptedPortfolioEvent, type PortfolioEventPayload } from "./portfolio-events";
import { validatePortfolio } from "./portfolio-validation";
import type { PortfolioStartupState, StartupStage } from "./portfolio-startup";
import { readVerifiedVault, saveVerifiedVault, type VerifiedVault } from "./verified-vault-cache";
import { STARTUP_TIMEOUT_MS } from "./operation-deadline";

export type RecoverySetup = Awaited<ReturnType<typeof createRecoveryVault<Seed>>>;
export type SessionState = { startup: PortfolioStartupState; seed: Seed | null; envelope: KabutoraVaultEnvelope | null; needsUnlock: boolean; cached: boolean; cachedAvailable: boolean; warning: string; recoveryPending?: boolean; unsaved?: number };
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** One account/session owns its listeners, key, replay revision and pending edits. */
export class PortfolioSession {
  state: SessionState = { startup: { stage: "vault" }, seed: null, envelope: null, needsUnlock: false, cached: false, cachedAvailable: false, warning: "" };
  private stopped = false;
  private unsubscribe: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private running = false;
  private rerun = false;
  private key: CryptoKey | null = null;
  private keyGeneration = "";
  private rawKey: string | null = null;
  private legacyKeys: Record<string, string> = {};
  private legacyRecord: GoogleAccountVaultKey | null = null;
  private legacyLoaded = false;
  private vaultLoaded = false;
  private events: StoredPortfolioEvent[] | null = null;
  private localEvents = new Map<string, DecryptedPortfolioEvent>();
  private decrypted = new Map<string, DecryptedPortfolioEvent>();
  private cachedVault: VerifiedVault | undefined;
  private compacting = false;
  private migrating = false;
  private writes: Promise<void> = Promise.resolve();
  private imported: Seed | null = null;
  private draft: VerifiedRecoveryDraft | null = null;
  private draftLoaded = false;
  private failedSaves: PortfolioEventPayload[] = [];
  private deferLegacyRecovery = process.env.NEXT_PUBLIC_KABUTORA_RECOVERY_MIGRATION !== "enabled";

  constructor(readonly uid: string, private mode: DeviceTrustMode, private store: PortfolioCloudStore, private publish: (state: SessionState) => void, private isCurrentUser: () => boolean) {}
  private active() { return !this.stopped && this.isCurrentUser(); }
  private emit(patch: Partial<SessionState>) { if (this.active()) { this.state = { ...this.state, ...patch }; this.publish(this.state); } }
  private stage(stage: PortfolioStartupState) { this.emit({ startup: stage }); }
  private fail(cause: unknown, failedStage: StartupStage = "event-replay") {
    if (!this.active()) return;
    this.clearDeadline();
    this.stage({ stage: "recoverable-error", failedStage, message: cause instanceof Error ? cause.message : "接続を確認して再試行してください。" });
  }
  private clearDeadline() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private deadline() {
    this.clearDeadline();
    this.timer = setTimeout(() => {
      const stage = this.state.startup.stage;
      this.fail(new Error("接続が15秒以内に完了しませんでした。暗号化データは保持されています。"), ["vault", "unlock", "event-replay"].includes(stage) ? stage as StartupStage : "vault");
    }, STARTUP_TIMEOUT_MS);
  }
  start() {
    configurePortfolioQueue(this.mode);
    this.deadline();
    if (this.mode === "trusted") void readVerifiedVault(this.uid).then((cached) => {
      if (cached?.uid === this.uid && isKabutoraVaultEnvelope(cached.envelope) && cached.envelope.ownerUid === this.uid) {
        this.cachedVault = cached;
        this.emit({ cachedAvailable: true });
      }
    }).catch(() => this.emit({ warning: "端末の保存領域を利用できません。復旧キーで解除でき、変更はこのタブのメモリに保持されます。" }));
    this.unsubscribe.push(this.store.subscribeVault(this.uid, (value, fromCache) => {
      if (!this.active() || fromCache) return;
      if (value && (!isKabutoraVaultEnvelope(value) || value.ownerUid !== this.uid)) return this.fail(new Error("暗号化保管庫の形式を確認できませんでした。"), "vault");
      this.vaultLoaded = true;
      const envelope = value as KabutoraVaultEnvelope | null;
      const changed = JSON.stringify(envelope) !== JSON.stringify(this.state.envelope);
      this.emit({ envelope });
      if (changed) this.decrypted.clear();
      this.schedule();
    }, (error) => this.fail(error, "vault")));
    this.unsubscribe.push(this.store.subscribeAccountKey(this.uid, (record) => {
      if (!this.active()) return;
      this.legacyRecord = record?.ownerUid === this.uid && record.format === "kabutora-google-account-key" ? record : null;
      this.legacyLoaded = true;
      this.schedule();
    }, () => { this.legacyLoaded = true; this.schedule(); }));
    this.unsubscribe.push(this.store.subscribeEvents(this.uid, (events, fromCache) => {
      if (!this.active() || fromCache) return;
      if (this.events && this.events.length === events.length && this.events.every((item, index) => item.id === events[index]?.id && item.payload.iv === events[index]?.payload.iv && item.keyId === events[index]?.keyId)) return;
      this.events = events;
      this.schedule();
    }, (error) => this.fail(error, "event-replay")));
  }
  private schedule() {
    this.revision += 1;
    this.rerun = true;
    if (this.running || this.migrating || !this.active()) return;
    this.running = true;
    void (async () => {
      while (this.rerun && this.active() && !this.migrating) {
        this.rerun = false;
        const revision = this.revision;
        try { await this.replay(revision); }
        catch (error) { if (revision === this.revision) this.fail(error, this.key ? "event-replay" : "unlock"); }
      }
    })().finally(() => { this.running = false; });
  }
  private async eventKey(event: StoredPortfolioEvent, envelope: KabutoraVaultEnvelope): Promise<CryptoKey> {
    if (event.ownerUid !== this.uid) throw new Error("event_owner_mismatch");
    const currentId = envelope.version === 2 ? envelope.keyId : this.legacyRecord?.keyId;
    if (event.keyId === currentId || (envelope.version === 1 && !event.keyId)) return this.key!;
    const legacy = this.legacyKeys[event.keyId ?? "legacy"];
    if (!legacy) throw new Error("以前の端末の変更を開く鍵が必要です。変更は削除されず保持されています。");
    return importGoogleAccountKey(legacy);
  }
  private async decryptEvents(events: StoredPortfolioEvent[], envelope: KabutoraVaultEnvelope, base: Seed) {
    const applied = new Set(base.sync?.appliedEventIds ?? []);
    const output: DecryptedPortfolioEvent[] = [];
    for (let index = 0; index < events.length; index += 1) {
      if (!this.active()) throw new Error("session_changed");
      const event = events[index]!;
      if (applied.has(event.id)) continue;
      const fingerprint = event.id + ":" + event.payload.iv + ":" + (event.keyId ?? "legacy");
      let decoded = this.decrypted.get(fingerprint);
      if (!decoded) {
        const key = await this.eventKey(event, envelope);
        decoded = { id: event.id, payload: validatePortfolioEvent(await decryptVaultRecord(key, event.payload)) };
        this.decrypted.set(fingerprint, decoded);
      }
      output.push(decoded);
      if (index % 32 === 31) await nextTurn();
    }
    return output;
  }
  private async replay(revision: number) {
    if (!this.vaultLoaded) return;
    const envelope = this.state.envelope;
    if (!envelope) { this.clearDeadline(); this.stage({ stage: "empty" }); return; }
    if (envelope.version === 1 && !this.legacyLoaded) return;
    const generation = envelope.keyId ?? this.legacyRecord?.keyId ?? "legacy";
    if (this.keyGeneration !== generation) { this.key = null; this.rawKey = null; this.keyGeneration = generation; }
    if (!this.key) {
      this.stage({ stage: "unlock" });
      const local = this.mode === "trusted" ? await loadTrustedDeviceKey(this.uid, envelope.keyId).catch(() => null) : null;
      if (local) {
        try { validatePortfolio(await decryptVaultWithDataKey(envelope, local)); this.key = local; } catch { /* Keep stored ciphertext and allow recovery unlock. */ }
      }
      if (!this.key && this.legacyRecord) {
        this.rawKey = this.legacyRecord.encodedKey;
        try {
          const legacy = await importGoogleAccountKey(this.rawKey);
          validatePortfolio(await decryptVaultWithDataKey(envelope, legacy));
          this.key = legacy;
        } catch { /* Stored key does not decrypt this envelope */ }
      }
      if (!this.key) { this.clearDeadline(); this.emit({ needsUnlock: true }); return; }
    }
    const key = this.key;
    const base = validatePortfolio(await decryptVaultWithDataKey(envelope, key));
    if (this.mode === "trusted" && !this.draftLoaded) {
      this.draftLoaded = true;
      this.draft = await loadVerifiedRecoveryDraft(this.uid).catch(() => null);
      if (this.draft?.envelope.keyId === envelope.keyId) {
        await clearVerifiedRecoveryDraft(this.uid).catch(() => undefined);
        this.draft = null;
      }
    }
    this.legacyKeys = await readLegacyVaultKeys(envelope, key);
    if (!this.events) { this.stage({ stage: "event-replay" }); return; }
    const pending = await getPendingPortfolioEvents(this.uid);
    const remote = await this.decryptEvents(this.events, envelope, base);
    const local = await this.decryptEvents(pending.map((item) => ({ id: item.id, ...item.event })), envelope, base);
    for (const item of local) this.localEvents.set(item.id, item);
    if (envelope.version === 2) {
      const incorporatedPending = pending.filter((item) => base.sync?.appliedEventIds.includes(item.id)).map((item) => item.id);
      if (incorporatedPending.length) await this.store.cleanupIncorporatedEvents(this.uid, envelope, incorporatedPending);
      for (const item of pending) if (item.event.keyId !== envelope.keyId && !base.sync?.appliedEventIds.includes(item.id)) {
        const payload = local.find((decoded) => decoded.id === item.id)?.payload;
        if (!payload) throw new Error("pending_event_conversion_failed");
        await replacePendingPortfolioEvent(this.uid, item.id, { ownerUid: this.uid, keyId: envelope.keyId, payload: await encryptVaultRecord(key, payload) });
      }
    }
    if (revision !== this.revision || !this.active()) return;
    const cloudSeed = replayPortfolioEvents(base, remote);
    for (const id of cloudSeed.sync?.appliedEventIds ?? []) this.localEvents.delete(id);
    const seed = replayPortfolioEvents(cloudSeed, [...this.localEvents.values()]);
    this.clearDeadline();
    const recoveryPending = Boolean(this.draft && this.draft.previousGeneration === generation);
    this.emit({ seed, needsUnlock: false, cached: false, recoveryPending, startup: { stage: (envelope.version === 1 && !this.deferLegacyRecovery) || this.imported || recoveryPending ? "enrollment" : "ready" } });
    if (this.mode === "trusted") void (async () => {
      await saveTrustedDeviceKey(this.uid, key, envelope.keyId).catch(() => undefined);
      const cached = await updateEncryptedVault(envelope, key, cloudSeed);
      if (this.active() && revision === this.revision) await saveVerifiedVault({ uid: this.uid, envelope: { ...cached, revision: envelope.revision }, verifiedAt: new Date().toISOString() });
    })().catch(() => this.emit({ warning: "確認済みデータを端末に保存できませんでした。接続中は利用できます。" }));
    void this.flush();
    void this.syncGoogleAccountAccess(envelope, cloudSeed);
    if (this.events.length >= PORTFOLIO_EVENT_COMPACTION_THRESHOLD && !this.compacting && (envelope.version === 2 || this.deferLegacyRecovery)) {
      this.compacting = true;
      const eventIds = this.events.map((event) => event.id);
      void updateEncryptedVault(envelope, key, cloudSeed, this.uid).then((next) => this.store.compactVaultWithEvents(this.uid, next, eventIds))
        .catch(() => { /* Revision conflict leaves all events intact; the next server snapshot retries. */ })
        .finally(() => { this.compacting = false; });
    }
  }
  private syncGoogleInProgress = false;
  private async syncGoogleAccountAccess(envelope: KabutoraVaultEnvelope, cloudSeed: Seed) {
    if (this.syncGoogleInProgress || !this.active()) return;
    if (this.legacyRecord?.ownerUid === this.uid && this.legacyRecord.encodedKey) {
      try {
        const testKey = await importGoogleAccountKey(this.legacyRecord.encodedKey);
        validatePortfolio(await decryptVaultWithDataKey(envelope, testKey));
        return;
      } catch {
        /* legacyRecord does not decrypt this envelope; proceed to sync */
      }
    }
    this.syncGoogleInProgress = true;
    try {
      if (this.rawKey) {
        const keyRecord: GoogleAccountVaultKey = {
          format: "kabutora-google-account-key",
          version: 1,
          ownerUid: this.uid,
          keyId: envelope.keyId ?? crypto.randomUUID(),
          encodedKey: this.rawKey,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveAccountKey(this.uid, keyRecord);
        this.legacyRecord = keyRecord;
      } else {
        const created = await createGoogleProtectedVault(cloudSeed, this.uid, {
          version: envelope.version,
          revision: envelope.revision + 1,
          keyId: envelope.keyId,
        });
        const keyRecord: GoogleAccountVaultKey = {
          format: "kabutora-google-account-key",
          version: 1,
          ownerUid: this.uid,
          keyId: created.envelope.keyId ?? crypto.randomUUID(),
          encodedKey: created.accountKey,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await this.store.saveGoogleProtectedVault(this.uid, created.envelope, keyRecord);
        if (this.events?.length) {
          const eventIds = this.events.map((event) => event.id);
          await this.store.cleanupIncorporatedEvents(this.uid, created.envelope, eventIds).catch(() => undefined);
        }
        if (this.mode === "trusted") {
          await saveTrustedDeviceKey(this.uid, created.dataKey, created.envelope.keyId).catch(() => undefined);
        }
        this.key = created.dataKey;
        this.rawKey = created.accountKey;
        this.legacyRecord = keyRecord;
        this.emit({ envelope: created.envelope });
      }
    } catch (error) {
      console.warn("Failed to sync Google account access:", error);
      /* Background sync failure leaves the active local session intact */
    } finally {
      this.syncGoogleInProgress = false;
    }
  }
  async unlock(value: string, mode: "passphrase" | "recovery", importedEnvelope?: KabutoraVaultEnvelope) {
    const envelope = importedEnvelope ?? this.state.envelope;
    if (!envelope) return;
    const unlocked = mode === "recovery" ? await unlockVaultWithRecoveryKey(envelope, value) : await unlockVaultWithPassphrase(envelope, value);
    const seed = validatePortfolio(unlocked.data);
    if (!this.active()) return;
    if (importedEnvelope) {
      this.imported = seed;
      this.key = unlocked.dataKey;
      this.rawKey = unlocked.accountKey;
      this.keyGeneration = importedEnvelope.keyId ?? this.state.envelope?.keyId ?? "legacy";
      this.emit({ seed, needsUnlock: false, startup: { stage: "enrollment" } });
      if (this.mode === "trusted") await saveTrustedDeviceKey(this.uid, unlocked.dataKey, importedEnvelope.keyId).catch(() => undefined);
      return;
    }
    this.key = unlocked.dataKey;
    this.rawKey = unlocked.accountKey;
    this.keyGeneration = envelope.keyId ?? this.legacyRecord?.keyId ?? "legacy";
    this.emit({ needsUnlock: false });
    if (this.mode === "trusted") await saveTrustedDeviceKey(this.uid, unlocked.dataKey, envelope.keyId).catch(() => this.emit({ warning: "この端末には解除鍵を保存できません。次回もパスフレーズまたは復旧キーで解除してください。" }));
    this.deadline();
    this.schedule();
  }
  needsLegacyCredential() { return Boolean(this.state.envelope && !this.rawKey && !this.legacyRecord); }
  async prepareRecovery(passphrase: string): Promise<RecoverySetup> {
    if (!this.state.seed || !this.key) throw new Error("vault_locked");
    const legacy = { ...this.legacyKeys };
    const raw = this.rawKey ?? this.legacyRecord?.encodedKey;
    if (this.state.envelope && !raw) throw new Error("以前の復旧キーまたはパスフレーズで一度解除してください。オフライン端末の変更を復元するために必要です。");
    if (raw) legacy[this.state.envelope?.keyId ?? this.legacyRecord?.keyId ?? "legacy"] = raw;
    if (raw && this.state.envelope?.version === 1) legacy.legacy = raw;
    return createRecoveryVault(this.imported ?? this.state.seed, passphrase, this.uid, legacy);
  }
  async activateRecovery(prepared: RecoverySetup, recoveryConfirmation: string) {
    const verified = await unlockVaultWithRecoveryKey<Seed>(prepared.envelope, recoveryConfirmation);
    validatePortfolio(verified.data);
    // A confirmation from another generation must never activate this one.
    await decryptVaultWithDataKey(prepared.envelope, verified.dataKey);
    if (this.mode === "trusted") await saveVerifiedRecoveryDraft(this.uid, this.state.envelope ? this.keyGeneration : null, prepared.envelope, prepared.dataKey)
      .catch(() => this.emit({ warning: "復旧設定はこのタブに保持されています。中断した場合は保存した復旧キーを使用してください。" }));
    return this.commitRecovery(prepared);
  }
  async resumeRecovery() {
    if (!this.draft || this.draft.previousGeneration !== (this.state.envelope ? this.keyGeneration : null)) throw new Error("verified_migration_unavailable");
    validatePortfolio(await decryptVaultWithDataKey(this.draft.envelope, this.draft.key));
    return this.commitRecovery({ envelope: this.draft.envelope, dataKey: this.draft.key, recoveryKey: "" });
  }
  private async commitRecovery(prepared: RecoverySetup) {
    await this.writes;
    if (!this.active()) throw new Error("session_changed");
    this.migrating = true;
    const expected = this.state.envelope?.revision ?? 0;
    const lease = await this.store.acquireWriteLock(this.uid, expected).catch((error) => { this.migrating = false; throw error; });
    try {
      const latest = await this.store.readForMigration(this.uid, lease);
      if (latest.envelope && !this.key) throw new Error("vault_locked");
      const base = this.imported ?? (latest.envelope ? validatePortfolio(await decryptVaultWithDataKey(latest.envelope, this.key!)) : this.state.seed!);
      const pending = await getPendingPortfolioEvents(this.uid);
      const oldEnvelope = latest.envelope ?? { ...prepared.envelope, version: 1 as const, keyId: undefined };
      const decoded = await this.decryptEvents([...latest.events, ...pending.map((item) => ({ id: item.id, ...item.event }))], oldEnvelope, base);
      const reconciled = replayPortfolioEvents(base, [...decoded, ...this.localEvents.values()]);
      const next = await updateEncryptedVault({ ...prepared.envelope, revision: expected }, prepared.dataKey, reconciled, this.uid);
      validatePortfolio(await decryptVaultWithDataKey(next, prepared.dataKey));
      if (!this.active()) throw new Error("session_changed");
      await this.store.activateGeneration(this.uid, lease, next, expected);
      if (!this.active()) return;
      this.key = prepared.dataKey;
      this.keyGeneration = next.keyId!;
      this.rawKey = null;
      this.legacyRecord = null;
      this.legacyKeys = await readLegacyVaultKeys(next, this.key);
      this.imported = null;
      this.emit({ envelope: next, seed: reconciled, recoveryPending: false, startup: { stage: "ready" } });
      if (this.mode === "trusted") {
        await saveTrustedDeviceKey(this.uid, this.key, next.keyId).catch(() => this.emit({ warning: "端末の解除鍵を保存できませんでした。保存した復旧キーで次回解除できます。" }));
        await clearVerifiedRecoveryDraft(this.uid).catch(() => undefined);
      }
      this.draft = null;
      await this.store.cleanupIncorporatedEvents(this.uid, next, [...new Set([...latest.events.map((event) => event.id), ...pending.map((event) => event.id)])]).catch(() => undefined);
    } finally {
      await this.store.releaseWriteLock(this.uid, lease).catch(() => undefined);
      this.migrating = false;
      this.schedule();
    }
  }
  async save(payloads: PortfolioEventPayload[]) {
    const operation = async () => {
      if (!this.active() || !this.key || !this.state.seed || this.migrating) throw new Error("vault_locked_or_migrating");
      for (let index = 0; index < payloads.length; index++) {
        const value = payloads[index]!;
        try {
        const preferenceSequence = value.kind === "preferences" ? Date.parse(value.value.updatedAt ?? "") : Number.NaN;
        // Advance the local clock even when a preference keeps its edit-time
        // sequence, so subsequent ordinary events remain newer locally.
        const localSequence = nextMonotonicTimestamp();
        const sequence = Number.isFinite(preferenceSequence) ? preferenceSequence : localSequence;
        const payload = validatePortfolioEvent({ ...value, clientSeq: sequence, clientTimestamp: new Date(sequence).toISOString() });
        const id = crypto.randomUUID();
        const record = { ownerUid: this.uid, payload: await encryptVaultRecord(this.key, payload), ...(this.state.envelope?.keyId ? { keyId: this.state.envelope.keyId } : this.legacyRecord ? { keyId: this.legacyRecord.keyId } : {}) };
        if (!this.active()) throw new Error("session_changed");
        await enqueuePendingPortfolioEvent(this.uid, id, record);
        this.localEvents.set(id, { id, payload });
        this.emit({ seed: replayPortfolioEvents(this.state.seed!, [{ id, payload }]) });
        } catch (error) {
          if (this.active()) {
            this.failedSaves.push(...payloads.slice(index));
            this.emit({ unsaved: this.failedSaves.length, warning: "未保存の変更をこのタブに保持しています。保存を再試行してください。" });
          }
          throw error;
        }
      }
      void this.flush();
    };
    const result = this.writes.then(operation);
    this.writes = result.catch(() => undefined);
    return result;
  }
  async retryFailedSaves() {
    const pending = this.failedSaves.splice(0);
    this.emit({ unsaved: 0 });
    await this.save(pending);
    this.emit({ warning: "" });
  }
  async flush(force = false) {
    if (!this.active() || this.migrating || !this.key || this.state.cached || !this.state.envelope || (this.state.envelope.version !== 2 && !this.deferLegacyRecovery)) return;
    if (force) await retryPortfolioQueueStorage(this.uid);
    await flushPendingPortfolioEvents(this.uid, async (uid, id, event) => {
      if (!this.active() || this.migrating) throw new Error("session_changed");
      if (event.keyId !== this.state.envelope?.keyId && !this.state.seed?.sync?.appliedEventIds.includes(id)) throw new Error("vault_generation_obsolete");
      await this.store.saveEvent(uid, id, event);
    }, force).catch(() => undefined);
  }
  async openCached() {
    if (!this.cachedVault || this.mode !== "trusted") throw new Error("verified_cache_unavailable");
    const key = await loadTrustedDeviceKey(this.uid, this.cachedVault.envelope.keyId);
    if (!key) throw new Error("端末の解除鍵を確認できません。パスフレーズまたは復旧キーで解除してください。");
    const envelope = this.cachedVault.envelope;
    const base = validatePortfolio(await decryptVaultWithDataKey(envelope, key));
    this.key = key;
    this.keyGeneration = envelope.keyId ?? this.legacyRecord?.keyId ?? "legacy";
    this.legacyKeys = await readLegacyVaultKeys(envelope, key);
    const pending = await getPendingPortfolioEvents(this.uid);
    const decoded = await this.decryptEvents(pending.map((item) => ({ id: item.id, ...item.event })), envelope, base);
    this.clearDeadline();
    this.emit({ envelope, seed: replayPortfolioEvents(base, decoded), cached: true, needsUnlock: false, startup: { stage: "ready" }, warning: `確認済みキャッシュ（${this.cachedVault.verifiedAt}）。最新のクラウド変更は未確認です。` });
  }
  stop() {
    this.stopped = true;
    this.clearDeadline();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    this.key = null; this.rawKey = null; this.legacyKeys = {}; this.events = null;
    this.decrypted.clear(); this.localEvents.clear(); this.cachedVault = undefined;
    this.failedSaves = []; this.draft = null; this.imported = null;
    this.state = { ...this.state, seed: null };
  }
}
