export type DeviceTrustMode = "trusted" | "shared";

export const firebaseClientConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(
  firebaseClientConfig.apiKey
  && firebaseClientConfig.authDomain
  && firebaseClientConfig.projectId
  && firebaseClientConfig.appId,
);

let deviceTrustMode: DeviceTrustMode = "shared";
let deviceTrustLocked = false;

export function configureDeviceTrust(mode: DeviceTrustMode) {
  if (deviceTrustLocked) {
    if (mode !== deviceTrustMode) throw new Error("端末の保存設定は起動後に変更できません。");
    return;
  }
  deviceTrustMode = mode;
}

export function getDeviceTrustMode() {
  return deviceTrustMode;
}

export function lockDeviceTrustConfiguration() {
  deviceTrustLocked = true;
}
