import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInitializeAppCheck = vi.fn();
const mockGetToken = vi.fn();
const mockReCaptchaEnterpriseProvider = vi.fn();
const mockReCaptchaV3Provider = vi.fn();

vi.mock("firebase/app", () => ({
  getApp: vi.fn(() => ({})),
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn(() => ({})),
}));

vi.mock("firebase/app-check", () => ({
  initializeAppCheck: mockInitializeAppCheck,
  getToken: mockGetToken,
  ReCaptchaEnterpriseProvider: mockReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider: mockReCaptchaV3Provider,
}));

vi.mock("firebase/auth", () => ({
  browserLocalPersistence: {},
  browserPopupRedirectResolver: {},
  getRedirectResult: vi.fn(),
  GoogleAuthProvider: vi.fn(),
  initializeAuth: vi.fn(() => ({
    currentUser: {
      uid: "test-user-123",
      getIdToken: vi.fn(async () => "mock-id-token"),
    },
  })),
  indexedDBLocalPersistence: {},
  inMemoryPersistence: {},
  signInWithRedirect: vi.fn(),
  signOut: vi.fn(),
  connectAuthEmulator: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  getFirestore: vi.fn(() => ({})),
  initializeFirestore: vi.fn(() => ({})),
  memoryLocalCache: vi.fn(() => ({})),
  connectFirestoreEmulator: vi.fn(),
}));

vi.mock("@/lib/firebase-config", () => ({
  firebaseClientConfig: {
    apiKey: "test-api-key",
    authDomain: "test-project.firebaseapp.com",
    projectId: "test-project",
    appId: "1:123456:web:abcdef",
  },
  firebaseConfigured: true,
  getDeviceTrustMode: vi.fn(() => "shared"),
  lockDeviceTrustConfiguration: vi.fn(),
}));

describe("firebase-client App Check reCAPTCHA provider", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { window: unknown }).window = {
      location: { hostname: "kabutora.test" },
    };
    mockInitializeAppCheck.mockReturnValue({ fakeAppCheck: true });
    mockGetToken.mockResolvedValue({ token: "app-check-token-xyz" });
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    process.env = { ...originalEnv };
  });

  it("instantiates ReCaptchaEnterpriseProvider by default when site key is set", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY = "6Lcqg3-mock-key";
    delete process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_PROVIDER;

    const { getFirebaseServices, getMarketAuthHeaders } = await import("./firebase-client");
    const services = getFirebaseServices();

    expect(mockReCaptchaEnterpriseProvider).toHaveBeenCalledWith("6Lcqg3-mock-key");
    expect(mockReCaptchaV3Provider).not.toHaveBeenCalled();
    expect(mockInitializeAppCheck).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        isTokenAutoRefreshEnabled: true,
      }),
    );
    expect(services.appCheck).toBeTruthy();

    const headers = await getMarketAuthHeaders();
    expect(headers).toEqual({
      Authorization: "Bearer mock-id-token",
      "X-Firebase-AppCheck": "app-check-token-xyz",
    });
  });

  it("instantiates ReCaptchaV3Provider when NEXT_PUBLIC_FIREBASE_APP_CHECK_PROVIDER is 'v3'", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY = "6Lcqg3-mock-v3-key";
    process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_PROVIDER = "v3";

    const { getFirebaseServices } = await import("./firebase-client");
    const services = getFirebaseServices();

    expect(mockReCaptchaV3Provider).toHaveBeenCalledWith("6Lcqg3-mock-v3-key");
    expect(mockReCaptchaEnterpriseProvider).not.toHaveBeenCalled();
    expect(services.appCheck).toBeTruthy();
  });
});
