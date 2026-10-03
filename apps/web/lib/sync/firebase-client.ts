"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider, getToken as getAppCheckToken, type AppCheck } from "firebase/app-check";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  getRedirectResult,
  GoogleAuthProvider,
  initializeAuth,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  signInWithRedirect,
  signOut,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  type Auth,
} from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  type Firestore,
  connectFirestoreEmulator,
} from "firebase/firestore";
import {
  firebaseClientConfig,
  firebaseConfigured,
  getDeviceTrustMode,
  lockDeviceTrustConfiguration,
} from "@/lib/sync/firebase-config";
import { withDeadline } from "../ui/operation-deadline";

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firestore: Firestore | null = null;
let appCheck: AppCheck | null = null;
let marketAuthHeadersTask: Promise<Record<string, string>> | null = null;
let marketAuthHeadersExpiresAt = 0;
let marketAuthHeadersUid = "";
let emulatorsConnected = false;
let memoryFallback = false;
let fallbackSequence = 0;
const emulatorMode = () => process.env.NEXT_PUBLIC_KABUTORA_EMULATORS === "1"
  && typeof window !== "undefined" && ["127.0.0.1", "localhost"].includes(window.location.hostname)
  && firebaseClientConfig.projectId?.startsWith("demo-");

export function getFirebaseServices() {
  if (!firebaseConfigured) throw new Error("Firebase設定が完了していません。");
  lockDeviceTrustConfiguration();
  const deviceTrustMode = getDeviceTrustMode();
  if (!firebaseApp) firebaseApp = memoryFallback ? initializeApp(firebaseClientConfig, `storage-recovery-${++fallbackSequence}`) : getApps().length ? getApp() : initializeApp(firebaseClientConfig);
  if (!firebaseAuth) firebaseAuth = initializeAuth(firebaseApp, {
    persistence: deviceTrustMode === "trusted" && !memoryFallback
      ? [indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence]
      : [inMemoryPersistence],
    ...(emulatorMode() ? {} : { popupRedirectResolver: browserPopupRedirectResolver }),
  });
  if (!firestore) {
    try {
      firestore = initializeFirestore(firebaseApp, {
        // Verified encrypted snapshots and the durable queue own offline state.
        // The SDK must not block the network behind unavailable IndexedDB.
        localCache: memoryLocalCache(),
      });
    } catch {
      firestore = getFirestore(firebaseApp);
    }
  }
  if (emulatorMode() && !emulatorsConnected) {
    connectAuthEmulator(firebaseAuth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(firestore, "127.0.0.1", 8085);
    emulatorsConnected = true;
  }
  if (!emulatorMode() && !appCheck && typeof window !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY) {
    try {
      const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY;
      // Existing deployments registered their key with App Check's v3
      // exchange. Enterprise requires a separate server-side registration;
      // an Enterprise-managed key alone does not select that exchange.
      const isEnterprise = process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_PROVIDER === "enterprise";
      const provider = isEnterprise
        ? new ReCaptchaEnterpriseProvider(siteKey)
        : new ReCaptchaV3Provider(siteKey);
      appCheck = initializeAppCheck(firebaseApp, {
        provider,
        isTokenAutoRefreshEnabled: true,
      });
    } catch (error) {
      console.error("Firebase App Check (reCAPTCHA) initialization failed:", error);
    }
  }
  return { app: firebaseApp, auth: firebaseAuth, db: firestore, appCheck };
}

export function enableMemoryFirebaseFallback() {
  memoryFallback = true;
  firebaseApp = null; firebaseAuth = null; firestore = null; appCheck = null;
  emulatorsConnected = false;
  marketAuthHeadersTask = null; marketAuthHeadersExpiresAt = 0; marketAuthHeadersUid = "";
}

export async function signInToKabutora() {
  const { auth } = getFirebaseServices();
  if (emulatorMode()) { await signInWithEmailAndPassword(auth, "synthetic@kabutora.test", "kabutora-emulator-only-password"); return; }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithRedirect(auth, provider);
}

export async function completeKabutoraSignInRedirect() {
  if (emulatorMode()) return null;
  return getRedirectResult(getFirebaseServices().auth);
}

export async function signOutOfKabutora() {
  marketAuthHeadersTask = null;
  marketAuthHeadersExpiresAt = 0;
  marketAuthHeadersUid = "";
  await signOut(getFirebaseServices().auth);
}

export async function getMarketAuthHeaders(): Promise<Record<string, string>> {
  if (!firebaseConfigured) return {};
  const { auth, appCheck: currentAppCheck } = getFirebaseServices();
  if (!auth.currentUser) {
    try {
      await withDeadline(auth.authStateReady(), 4_000, "market-auth-ready");
    } catch {
      /* Timeout or unconfigured auth leaves headers empty */
    }
  }
  if (!auth.currentUser) return {};
  if (marketAuthHeadersTask && marketAuthHeadersUid === auth.currentUser.uid && Date.now() < marketAuthHeadersExpiresAt) return marketAuthHeadersTask;
  const user = auth.currentUser;
  marketAuthHeadersUid = user.uid;
  marketAuthHeadersTask = (async () => {
    const [idToken, appCheckResult] = await Promise.all([
      withDeadline(user.getIdToken(), 8_000, "market-authentication"),
      currentAppCheck ? withDeadline(getAppCheckToken(currentAppCheck, false), 8_000, "app-check") : Promise.resolve(null),
    ]);
    const headers: Record<string, string> = { Authorization: `Bearer ${idToken}` };
    if (appCheckResult) headers["X-Firebase-AppCheck"] = appCheckResult.token;
    return headers;
  })();
  marketAuthHeadersExpiresAt = Date.now() + 30_000;
  try {
    return await marketAuthHeadersTask;
  } catch (error) {
    marketAuthHeadersTask = null;
    marketAuthHeadersExpiresAt = 0;
    marketAuthHeadersUid = "";
    throw error;
  }
}
