"use client";

import Dashboard, { type Seed } from "@/components/dashboard";
import AppLoadingScreen from "@/components/app-loading-screen";
import EncryptedBackupDialog from "@/components/encrypted-backup-dialog";
import { completeKabutoraSignInRedirect, getFirebaseServices, signInToKabutora, signOutOfKabutora } from "@/lib/firebase-client";
import {
  createGoogleProtectedVault,
  decryptVaultWithDataKey,
  decryptVaultRecord,
  encryptVaultRecord,
  isKabutoraVaultEnvelope,
  importGoogleAccountKey,
  unlockVaultWithPassphrase,
  unlockVaultWithRecoveryKey,
  type KabutoraVaultEnvelope,
} from "@/lib/vault-crypto";
import {
  deleteTrustedDeviceKey,
  loadTrustedDeviceKey,
  saveTrustedDeviceKey,
} from "@/lib/trusted-device-key-store";
import {
  createFirebasePortfolioCloudStore,
  portfolioEventSnapshotSignature,
  portfolioEventsSnapshotIsReady,
  type EncryptedPortfolioEvent,
  type GoogleAccountVaultKey,
} from "@/lib/portfolio-cloud-store";
import type { User } from "firebase/auth";
import { FileKey, KeyRound, LockKeyhole, LogOut, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeviceTrustMode } from "@/lib/firebase-config";
import { diffTransactionChanges, mergeLatestTransactions } from "@/lib/transaction-event-merge";
import { isNewerAccountRevision, mergeLatestAccounts } from "@/lib/account-event-merge";
import type { MarketSessionStatus } from "@/lib/market-session";
import { settleInitialAuthSession } from "@/lib/initial-auth-session";

const errorMessage = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

type PortfolioEventPayload =
  | { kind: "transaction"; value: Seed["transactions"][number] }
  | { kind: "transaction-delete"; value: { id: string; deletedAt: string } }
  | { kind: "account"; value: Seed["accounts"][number] }
  | { kind: "security"; value: Seed["securities"][number] };

const SHARED_DEVICE_IDLE_LOCK_MS = 10 * 60 * 1000;

export default function CloudPortfolioApp({ deviceMode, initialServerTimeMs, initialMarketSessions }: { deviceMode: DeviceTrustMode; initialServerTimeMs: number; initialMarketSessions: MarketSessionStatus[] }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [vaultLoaded, setVaultLoaded] = useState(false);
  const [accountKeyLoaded, setAccountKeyLoaded] = useState(false);
  const [accountKeyRecord, setAccountKeyRecord] = useState<GoogleAccountVaultKey | null>(null);
  const [envelope, setEnvelope] = useState<KabutoraVaultEnvelope | null>(null);
  const [seed, setSeed] = useState<Seed | null>(null);
  const [dataKey, setDataKey] = useState<CryptoKey | null>(null);
  const [unlockValue, setUnlockValue] = useState("");
  const [unlockMode, setUnlockMode] = useState<"passphrase" | "recovery">("passphrase");
  const [importEnvelope, setImportEnvelope] = useState<KabutoraVaultEnvelope | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [backupSeed, setBackupSeed] = useState<Seed | null>(null);
  const [deviceUnlockState, setDeviceUnlockState] = useState<"idle" | "checking" | "done">("idle");
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [accountKeyMigration, setAccountKeyMigration] = useState<"idle" | "saving" | "done" | "failed">("idle");
  const baseSeedRef = useRef<Seed | null>(null);
  const eventTransactionsRef = useRef<Seed["transactions"]>([]);
  const deletedTransactionIdsRef = useRef<Set<string>>(new Set());
  const eventAccountsRef = useRef<Seed["accounts"]>([]);
  const eventSecuritiesRef = useRef<Seed["securities"]>([]);
  const eventSnapshotVersionRef = useRef(0);
  const eventSnapshotSignatureRef = useRef("");
  const pendingEventSnapshotSignatureRef = useRef("");
  const migrationStartedRef = useRef(false);
  const cloudStore = useMemo(() => createFirebasePortfolioCloudStore(getFirebaseServices().db), []);

  const lock = useCallback(() => {
    setSeed(null);
    setDataKey(null);
    setUnlockValue("");
    baseSeedRef.current = null;
    eventTransactionsRef.current = [];
    deletedTransactionIdsRef.current = new Set();
    eventAccountsRef.current = [];
    eventSecuritiesRef.current = [];
    eventSnapshotVersionRef.current += 1;
    eventSnapshotSignatureRef.current = "";
    pendingEventSnapshotSignatureRef.current = "";
    setEventsLoaded(false);
  }, []);

  useEffect(() => {
    const { auth } = getFirebaseServices();
    let active = true;
    let observedUid: string | null | undefined;
    const applyAuthState = (nextUser: User | null) => {
      if (!active) return;
      setUser(nextUser);
      const nextUid = nextUser?.uid ?? null;
      if (observedUid === nextUid) return;
      observedUid = nextUid;
      setVaultLoaded(false);
      setAccountKeyLoaded(false);
      setAccountKeyRecord(null);
      setEnvelope(null);
      setDeviceUnlockState("idle");
      setSessionLocked(false);
      setAccountKeyMigration("idle");
      migrationStartedRef.current = false;
      lock();
    };
    const unsubscribe = auth.onAuthStateChanged(applyAuthState);
    void (async () => {
      const initialSession = await settleInitialAuthSession({
        completeRedirect: completeKabutoraSignInRedirect,
        authStateReady: () => auth.authStateReady(),
        currentUser: () => auth.currentUser,
      });
      if (!active) return;
      if (initialSession.redirectFailed) setError("Googleサインインの結果を確認できませんでした。もう一度お試しください。");
      applyAuthState(initialSession.user);
      setAuthReady(true);
    })().catch(() => {
      if (!active) return;
      setError("Googleのログイン状態を確認できませんでした。通信状態を確認して、もう一度お試しください。");
      setAuthReady(true);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [lock]);

  useEffect(() => {
    if (!user) return;
    return cloudStore.subscribeVault(user.uid, (value) => {
      setVaultLoaded(true);
      if (!value) return setEnvelope(null);
      if (!isKabutoraVaultEnvelope(value) || value.ownerUid !== user.uid) {
        setError("クラウド上の暗号化データ形式を確認できませんでした。");
        return;
      }
      setEnvelope(value);
    }, (cause) => {
      setVaultLoaded(true);
      setError(errorMessage(cause, "暗号化データへ接続できませんでした。"));
    });
  }, [cloudStore, user]);

  useEffect(() => {
    if (!user) return;
    return cloudStore.subscribeAccountKey(user.uid, (value) => {
      setAccountKeyRecord(value?.ownerUid === user.uid && value.format === "kabutora-google-account-key" ? value : null);
      setAccountKeyLoaded(true);
    }, (cause) => {
      setAccountKeyLoaded(true);
      setError(errorMessage(cause, "Googleアカウント鍵へ接続できませんでした。"));
    });
  }, [cloudStore, user]);

  useEffect(() => {
    if (!user || !envelope || importEnvelope || dataKey || sessionLocked || !accountKeyLoaded) {
      setDeviceUnlockState("done");
      return;
    }
    let active = true;
    setDeviceUnlockState("checking");
    void (async () => {
      const localKey = deviceMode === "trusted" ? await loadTrustedDeviceKey(user.uid) : null;
      if (localKey) {
        try {
          const unlockedSeed = await decryptVaultWithDataKey<Seed>(envelope, localKey);
          if (!active) return;
          setDataKey(localKey);
          baseSeedRef.current = unlockedSeed;
          setSeed(unlockedSeed);
          setUnlockValue("");
          return;
        } catch {
          await deleteTrustedDeviceKey(user.uid).catch(() => undefined);
        }
      }
      if (!accountKeyRecord) return;
      const googleKey = await importGoogleAccountKey(accountKeyRecord.encodedKey);
      const unlockedSeed = await decryptVaultWithDataKey<Seed>(envelope, googleKey);
      if (!active) return;
      if (deviceMode === "trusted") await saveTrustedDeviceKey(user.uid, googleKey).catch(() => undefined);
      setDataKey(googleKey);
      baseSeedRef.current = unlockedSeed;
      setSeed(unlockedSeed);
      setUnlockValue("");
    })().catch(() => {
      if (active) setError("Googleアカウントの解除鍵でデータを開けませんでした。バックアップから復元してください。");
    }).finally(() => {
      if (active) setDeviceUnlockState("done");
    });
    return () => { active = false; };
  }, [accountKeyLoaded, accountKeyRecord, dataKey, deviceMode, envelope, importEnvelope, sessionLocked, user]);

  useEffect(() => {
    if (!user || !dataKey || !baseSeedRef.current) return;
    let active = true;
    const unsubscribe = cloudStore.subscribeEvents(user.uid, (events, fromCache) => {
      const snapshotReady = portfolioEventsSnapshotIsReady(fromCache, navigator.onLine);
      if (snapshotReady) setEventsLoaded(true);
      const signature = portfolioEventSnapshotSignature(events);
      if (signature === eventSnapshotSignatureRef.current || signature === pendingEventSnapshotSignatureRef.current) return;
      pendingEventSnapshotSignatureRef.current = signature;
      const snapshotVersion = ++eventSnapshotVersionRef.current;
      void Promise.all(events.map(async (value) => {
        if (value.ownerUid !== user.uid || !value.payload) return null;
        if (accountKeyRecord && value.keyId !== accountKeyRecord.keyId) return null;
        const decrypted = await decryptVaultRecord<PortfolioEventPayload>(dataKey, value.payload);
        return decrypted && ["transaction", "transaction-delete", "account", "security"].includes(decrypted.kind) ? decrypted : null;
      })).then((items) => {
        if (!active || !baseSeedRef.current || snapshotVersion !== eventSnapshotVersionRef.current) return;
        eventTransactionsRef.current = items.filter((item): item is { kind: "transaction"; value: Seed["transactions"][number] } => item?.kind === "transaction").map((item) => item.value);
        deletedTransactionIdsRef.current = new Set(items.filter((item): item is { kind: "transaction-delete"; value: { id: string; deletedAt: string } } => item?.kind === "transaction-delete").map((item) => item.value.id));
        eventAccountsRef.current = items.filter((item): item is { kind: "account"; value: Seed["accounts"][number] } => item?.kind === "account").map((item) => item.value);
        eventSecuritiesRef.current = items.filter((item): item is { kind: "security"; value: Seed["securities"][number] } => item?.kind === "security").map((item) => item.value);
        const merged = mergeLatestTransactions(baseSeedRef.current.transactions, eventTransactionsRef.current).filter((transaction) => !deletedTransactionIdsRef.current.has(transaction.id));
        const mergedAccounts = mergeLatestAccounts(baseSeedRef.current.accounts, eventAccountsRef.current);
        const mergedSecurities = [...new Map([...baseSeedRef.current.securities, ...eventSecuritiesRef.current].map((security) => [security.id, security])).values()];
        setSeed({ ...baseSeedRef.current, accounts: mergedAccounts, securities: mergedSecurities, transactions: merged });
        eventSnapshotSignatureRef.current = signature;
        if (pendingEventSnapshotSignatureRef.current === signature) pendingEventSnapshotSignatureRef.current = "";
      }).catch((cause) => {
        if (pendingEventSnapshotSignatureRef.current === signature) pendingEventSnapshotSignatureRef.current = "";
        setEventsLoaded(true);
        setError(errorMessage(cause, "同期データを復号できませんでした。"));
      });
    }, (cause) => {
      eventSnapshotVersionRef.current += 1;
      setEventsLoaded(true);
      setError(errorMessage(cause, "同期データへ接続できませんでした。"));
    });
    return () => { active = false; unsubscribe(); };
  }, [accountKeyRecord, cloudStore, dataKey, user]);

  useEffect(() => {
    if (!user || !envelope || !seed || !dataKey || !accountKeyLoaded || accountKeyRecord || !eventsLoaded || importEnvelope || accountKeyMigration !== "idle" || migrationStartedRef.current) return;
    migrationStartedRef.current = true;
    setAccountKeyMigration("saving");
    void createGoogleProtectedVault(seed, user.uid).then(async (created) => {
      const now = new Date().toISOString();
      const record: GoogleAccountVaultKey = {
        format: "kabutora-google-account-key",
        version: 1,
        ownerUid: user.uid,
        keyId: crypto.randomUUID(),
        encodedKey: created.accountKey,
        createdAt: now,
        updatedAt: now,
      };
      await cloudStore.saveGoogleProtectedVault(user.uid, created.envelope, record);
      await cloudStore.deleteAllEvents(user.uid).catch(() => undefined);
      if (getFirebaseServices().auth.currentUser?.uid !== user.uid) return;
      if (deviceMode === "trusted") await saveTrustedDeviceKey(user.uid, created.dataKey).catch(() => undefined);
      setEnvelope(created.envelope);
      setAccountKeyRecord(record);
      setDataKey(created.dataKey);
      baseSeedRef.current = seed;
      setSeed(seed);
      setAccountKeyMigration("done");
    }).catch((cause) => {
      if (getFirebaseServices().auth.currentUser?.uid !== user.uid) return;
      setAccountKeyMigration("failed");
      setError(errorMessage(cause, "Googleアカウントでの自動解除を設定できませんでした。"));
    });
  }, [accountKeyLoaded, accountKeyMigration, accountKeyRecord, cloudStore, dataKey, deviceMode, envelope, eventsLoaded, importEnvelope, seed, user]);

  useEffect(() => {
    if (!dataKey || deviceMode !== "shared") return;
    const lockSharedSession = () => {
      setSessionLocked(true);
      lock();
    };
    let idleTimer = window.setTimeout(lockSharedSession, SHARED_DEVICE_IDLE_LOCK_MS);
    const resetIdleTimer = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(lockSharedSession, SHARED_DEVICE_IDLE_LOCK_MS);
    };
    const pageHide = () => lockSharedSession();
    const visibilityChange = () => {
      if (document.visibilityState === "hidden") lockSharedSession();
    };
    const activityEvents: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
    for (const eventName of activityEvents) window.addEventListener(eventName, resetIdleTimer, { passive: true });
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibilityChange);
    return () => {
      window.clearTimeout(idleTimer);
      for (const eventName of activityEvents) window.removeEventListener(eventName, resetIdleTimer);
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibilityChange);
    };
  }, [dataKey, deviceMode, lock]);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = importEnvelope ?? envelope;
    if (!target || !user) return;
    setBusy(true);
    setError("");
    try {
      const unlocked = unlockMode === "recovery"
        ? await unlockVaultWithRecoveryKey<Seed>(target, unlockValue)
        : await unlockVaultWithPassphrase<Seed>(target, unlockValue);
      const ownedEnvelope = { ...target, ownerUid: user.uid } satisfies KabutoraVaultEnvelope;
      if (importEnvelope) {
        const now = new Date().toISOString();
        const record: GoogleAccountVaultKey = {
          format: "kabutora-google-account-key",
          version: 1,
          ownerUid: user.uid,
          keyId: crypto.randomUUID(),
          encodedKey: unlocked.accountKey,
          createdAt: accountKeyRecord?.createdAt ?? now,
          updatedAt: now,
        };
        await cloudStore.saveGoogleProtectedVault(user.uid, ownedEnvelope, record);
        await cloudStore.deleteAllEvents(user.uid).catch(() => undefined);
        setAccountKeyRecord(record);
        setImportEnvelope(null);
      }
      let enrollmentWarning = "";
      if (deviceMode === "trusted") {
        try {
          await saveTrustedDeviceKey(user.uid, unlocked.dataKey);
        } catch {
          enrollmentWarning = "このブラウザには端末用の鍵を保存できませんでした。次回はGoogle認証済みのクラウド鍵で解除します。";
        }
      }
      setEnvelope(ownedEnvelope);
      setDataKey(unlocked.dataKey);
      baseSeedRef.current = unlocked.data;
      setSeed(unlocked.data);
      setUnlockValue("");
      setError(enrollmentWarning);
    } catch (cause) {
      setError(errorMessage(cause, "復号できませんでした。"));
    } finally {
      setBusy(false);
    }
  };

  const manuallyLock = async () => {
    setSessionLocked(true);
    lock();
  };

  const signOutSession = async () => {
    if (user && deviceMode === "trusted") {
      await deleteTrustedDeviceKey(user.uid).catch(() => undefined);
    }
    lock();
    await signOutOfKabutora();
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      const value = JSON.parse(await file.text()) as unknown;
      if (!isKabutoraVaultEnvelope(value)) throw new Error("株トラの暗号化バックアップではありません。");
      setImportEnvelope(value);
    } catch (cause) {
      setError(errorMessage(cause, "ファイルを読み込めませんでした。"));
    }
  };

  const saveTransactions = async (transactions: Seed["transactions"]) => {
    if (!user || !dataKey || !seed) return;
    const { upserts: additionsOrUpdates, deletions } = diffTransactionChanges(seed.transactions, transactions);
    if (!additionsOrUpdates.length && !deletions.length) return;
    try {
      await Promise.all([
        ...additionsOrUpdates.map(async (transaction) => {
          const payload = await encryptVaultRecord(dataKey, { kind: "transaction", value: transaction } satisfies PortfolioEventPayload);
          const record: EncryptedPortfolioEvent = { ownerUid: user.uid, payload, ...(accountKeyRecord ? { keyId: accountKeyRecord.keyId } : {}) };
          await cloudStore.saveEvent(user.uid, crypto.randomUUID(), record);
        }),
        ...deletions.map(async (transaction) => {
          const payload = await encryptVaultRecord(dataKey, { kind: "transaction-delete", value: { id: transaction.id, deletedAt: new Date().toISOString() } } satisfies PortfolioEventPayload);
          const record: EncryptedPortfolioEvent = { ownerUid: user.uid, payload, ...(accountKeyRecord ? { keyId: accountKeyRecord.keyId } : {}) };
          await cloudStore.saveEvent(user.uid, crypto.randomUUID(), record);
        }),
      ]);
    } catch (cause) {
      setError(errorMessage(cause, "暗号化した取引を同期できませんでした。"));
    }
  };

  const saveAccounts = async (accounts: Seed["accounts"]) => {
    if (!user || !dataKey || !seed) return;
    const knownAccounts = new Map(seed.accounts.map((account) => [account.id, account]));
    const changes = accounts.filter((account) => {
      const known = knownAccounts.get(account.id);
      if (!known) return true;
      return isNewerAccountRevision(account, known);
    });
    if (!changes.length) return;
    try {
      await Promise.all(changes.map(async (account) => {
        const payload = await encryptVaultRecord(dataKey, { kind: "account", value: account } satisfies PortfolioEventPayload);
        const record: EncryptedPortfolioEvent = { ownerUid: user.uid, payload, ...(accountKeyRecord ? { keyId: accountKeyRecord.keyId } : {}) };
        await cloudStore.saveEvent(user.uid, crypto.randomUUID(), record);
      }));
    } catch (cause) {
      setError(errorMessage(cause, "証券口座を同期できませんでした。"));
    }
  };

  const saveSecurities = async (securities: Seed["securities"]) => {
    if (!user || !dataKey || !seed) return;
    const knownIds = new Set(seed.securities.map((security) => security.id));
    const additions = securities.filter((security) => !knownIds.has(security.id));
    if (!additions.length) return;
    try {
      await Promise.all(additions.map(async (security) => {
        const payload = await encryptVaultRecord(dataKey, { kind: "security", value: security } satisfies PortfolioEventPayload);
        const record: EncryptedPortfolioEvent = { ownerUid: user.uid, payload, ...(accountKeyRecord ? { keyId: accountKeyRecord.keyId } : {}) };
        await cloudStore.saveEvent(user.uid, crypto.randomUUID(), record);
      }));
    } catch (cause) {
      setError(errorMessage(cause, "銘柄情報を同期できませんでした。"));
    }
  };

  const startSignIn = async () => {
    setBusy(true);
    setError("");
    try {
      await signInToKabutora();
    } catch {
      setError("Googleサインインを開始できませんでした。ページを再読み込みして、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  if (!authReady) return <AppLoadingScreen label="アカウントを確認中" detail="Googleのログイン状態を安全に確認しています" />;
  if (!user) return <SecureGate icon={<LockKeyhole size={30}/>} title="株トラへサインイン"><button className="google-signin-button" type="button" disabled={busy} aria-label="Googleでサインイン" aria-busy={busy} onClick={() => void startSignIn()}><img src="/sign-in-with-google.png" alt="" width="720" height="160" /></button>{error && <p className="form-error" role="alert">{error}</p>}</SecureGate>;
  if (!vaultLoaded) return <AppLoadingScreen label="保管庫に接続中" detail="暗号化ポートフォリオをクラウドから確認しています" />;

  if (!accountKeyLoaded) return <AppLoadingScreen label="解除鍵を確認中" detail="このアカウントでデータを開く準備をしています" />;

  if (accountKeyMigration === "saving") return <AppLoadingScreen label="同期方式を更新中" detail="暗号化データを新しい方式へ安全に移行しています" />;

  if (!envelope && !importEnvelope) return <SecureGate icon={<FileKey size={30}/>} title="暗号化バックアップを読み込む" description="Macの株トラで作成した暗号化JSONを選択します。ファイルは復号確認後に暗号文のまま同期されます。">
    <label className="file-button"><Upload size={16}/>ファイルを選択<input type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0])}/></label>
    {error && <p className="form-error">{error}</p>}
    <button className="text-button" onClick={() => void signOutSession()}><LogOut size={14}/>別のアカウントを使用</button>
  </SecureGate>;

  if (sessionLocked && !importEnvelope) return <SecureGate icon={<LockKeyhole size={30}/>} title="ポートフォリオはロック中" description="Googleアカウントのログイン状態を確認して再度開きます。"><button className="trade-button secure-action" onClick={() => setSessionLocked(false)}>Googleアカウントで開く</button><button className="text-button" onClick={() => void signOutSession()}><LogOut size={14}/>ログアウト</button></SecureGate>;

  if (envelope && !importEnvelope && deviceUnlockState !== "done") return <AppLoadingScreen label="ポートフォリオを復号中" detail="端末内の解除鍵で暗号化データを開いています" />;

  if (seed && dataKey && !eventsLoaded) return <AppLoadingScreen label="最新データを同期中" detail="取引・口座・銘柄の変更を反映しています" />;

  if (!seed || !dataKey) return <SecureGate icon={importEnvelope ? <KeyRound size={30}/> : <FileKey size={30}/>} title={importEnvelope ? "バックアップを復元" : "このアカウントの解除鍵がありません"} description={importEnvelope ? "選択した暗号化JSONを、このバックアップ用のパスフレーズまたは復旧キーで復元します。" : "既存端末で株トラを一度開くとGoogleアカウント用の鍵が自動登録されます。すぐに復元する場合だけ暗号化JSONを選択してください。"}>
    {!importEnvelope && <>
      <label className="file-button"><Upload size={16}/>バックアップから復元<input type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0])}/></label>
      {error && <p className="form-error">{error}</p>}
      <button className="text-button" onClick={() => void signOutSession()}><LogOut size={14}/>別のアカウントを使用</button>
    </>}
    {importEnvelope &&
    <form className="unlock-form" onSubmit={unlock}>
      <div className="segmented big"><button type="button" className={unlockMode === "passphrase" ? "active" : ""} onClick={() => setUnlockMode("passphrase")}>パスフレーズ</button><button type="button" className={unlockMode === "recovery" ? "active" : ""} onClick={() => setUnlockMode("recovery")}>復旧キー</button></div>
      <input type="password" autoComplete="off" value={unlockValue} onChange={(event) => setUnlockValue(event.target.value)} placeholder={unlockMode === "passphrase" ? "16文字以上" : "KBT1-…"} required />
      {error && <p className="form-error">{error}</p>}
      <button className="trade-button full" disabled={busy}>{busy ? "端末内で復号中…" : "復号して同期を開始"}</button>
      <button type="button" className="text-button" onClick={() => { setImportEnvelope(null); setUnlockValue(""); }}>キャンセル</button>
    </form>
    }
  </SecureGate>;

  return <div className="cloud-shell">
    <Dashboard seed={seed} initialServerTimeMs={initialServerTimeMs} initialMarketSessions={initialMarketSessions} persistenceMode="cloud" onTransactionsChange={saveTransactions} onAccountsChange={saveAccounts} onSecuritiesChange={saveSecurities} onEncryptedBackup={setBackupSeed} allowPlaintextExport={false} allowPersistentMarketCache={deviceMode === "trusted"} onLock={manuallyLock} onLogout={signOutSession}/>
    {error && <div className="cloud-error" role="alert">{error}</div>}
    {backupSeed && <EncryptedBackupDialog seed={backupSeed} ownerUid={user.uid} onClose={() => setBackupSeed(null)}/>} 
  </div>;
}

function SecureGate({ icon, title, description, children }: { icon: React.ReactNode; title: string; description?: string; children?: React.ReactNode }) {
  return <main className="secure-gate"><div className="secure-gate-icon">{icon}</div><h1>{title}</h1>{description && <p>{description}</p>}{children}</main>;
}
