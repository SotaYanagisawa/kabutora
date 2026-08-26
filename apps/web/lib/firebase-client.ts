"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider, getToken as getAppCheckToken, type AppCheck } from "firebase/app-check";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  getRedirectResult,
  GoogleAuthProvider,
  initializeAuth,
  indexedDBLocalPersistence,
  signInWithRedirect,
  signOut,
  type Auth,
} from "firebase/auth";
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";
import {
  firebaseClientConfig,
  firebaseConfigured,
  getDeviceTrustMode,
  lockDeviceTrustConfiguration,
} from "@/lib/firebase-config";

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firestore: Firestore | null = null;
let appCheck: AppCheck | null = null;

export function getFirebaseServices() {
  if (!firebaseConfigured) throw new Error("Firebase設定が完了していません。");
  lockDeviceTrustConfiguration();
  const deviceTrustMode = getDeviceTrustMode();
  if (!firebaseApp) firebaseApp = getApps().length ? getApp() : initializeApp(firebaseClientConfig);
  if (!firebaseAuth) firebaseAuth = initializeAuth(firebaseApp, {
    persistence: deviceTrustMode === "trusted"
      ? [indexedDBLocalPersistence, browserLocalPersistence]
      : browserSessionPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  if (!firestore) {
    try {
      firestore = initializeFirestore(firebaseApp, {
        localCache: deviceTrustMode === "trusted"
          ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
          : memoryLocalCache(),
      });
    } catch {
      firestore = getFirestore(firebaseApp);
    }
  }
  if (!appCheck && typeof window !== "undefined" && process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY) {
    appCheck = initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaV3Provider(process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return { app: firebaseApp, auth: firebaseAuth, db: firestore, appCheck };
}

export async function signInToKabutora() {
  const { auth } = getFirebaseServices();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithRedirect(auth, provider);
}

export async function completeKabutoraSignInRedirect() {
  return getRedirectResult(getFirebaseServices().auth);
}

export async function signOutOfKabutora() {
  await signOut(getFirebaseServices().auth);
}

export async function getMarketAuthHeaders(): Promise<Record<string, string>> {
  if (!firebaseConfigured) return {};
  const { auth, appCheck: currentAppCheck } = getFirebaseServices();
  if (!auth.currentUser) return {};
  const headers: Record<string, string> = { Authorization: `Bearer ${await auth.currentUser.getIdToken()}` };
  if (currentAppCheck) headers["X-Firebase-AppCheck"] = (await getAppCheckToken(currentAppCheck, false)).token;
  return headers;
}
