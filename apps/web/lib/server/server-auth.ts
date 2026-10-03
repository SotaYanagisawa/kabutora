import { createRemoteJWKSet, decodeProtectedHeader, importX509, jwtVerify, type JWTPayload } from "jose";

const FIREBASE_CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const appCheckKeys = createRemoteJWKSet(new URL("https://firebaseappcheck.googleapis.com/v1/jwks"));

let certificateCache: { expiresAt: number; values: Record<string, string> } | null = null;
const importedCertificates = new Map<string, { certificate: string; key: Promise<CryptoKey> }>();

const cacheMaxAge = (header: string | null) => {
  const match = /max-age=(\d+)/u.exec(header ?? "");
  return match ? Number(match[1]) * 1000 : 60 * 60 * 1000;
};

export class MarketAuthUnavailable extends Error {}
let certificateFlight: Promise<void> | null = null;
let lastCertificateRefresh = 0;

async function refreshFirebaseCertificates() {
  if (certificateFlight) return certificateFlight;
  certificateFlight = (async () => {
    try {
      const response = await fetch(FIREBASE_CERTS_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new MarketAuthUnavailable("authentication_keys_unavailable");
      const values: unknown = await response.json();
      if (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((value) => typeof value !== "string")) throw new MarketAuthUnavailable("authentication_keys_invalid");
      certificateCache = { values: values as Record<string, string>, expiresAt: Date.now() + Math.min(cacheMaxAge(response.headers.get("Cache-Control")), 6 * 60 * 60_000) };
      lastCertificateRefresh = Date.now();
      for (const id of importedCertificates.keys()) if (!Object.hasOwn(certificateCache.values, id)) importedCertificates.delete(id);
    } catch (error) {
      if (error instanceof MarketAuthUnavailable) throw error;
      throw new MarketAuthUnavailable("authentication_keys_unavailable");
    }
  })().finally(() => { certificateFlight = null; });
  return certificateFlight;
}
async function getFirebaseCertificate(kid: string) {
  if (!certificateCache || certificateCache.expiresAt <= Date.now()) await refreshFirebaseCertificates();
  // Key rotation may happen before the previous certificate cache expires.
  // Rate-limit unknown-key refreshes to prevent invalid tokens creating a storm.
  if (!Object.hasOwn(certificateCache!.values, kid) && Date.now() - lastCertificateRefresh >= 60_000) await refreshFirebaseCertificates();
  const certificate = certificateCache!.values[kid];
  if (!certificate) throw new Error("unknown_authentication_key");
  return certificate;
}

export function configuredMarketMembers(env: Record<string, string | undefined>): Set<string> {
  return new Set((env.KABUTORA_ALLOWED_UIDS ?? env.KABUTORA_ALLOWED_UID ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

async function verifyFirebaseIdToken(token: string, projectId: string): Promise<JWTPayload> {
  const header = decodeProtectedHeader(token);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Invalid Firebase token header");
  const certificate = await getFirebaseCertificate(header.kid);
  let imported = importedCertificates.get(header.kid);
  if (!imported || imported.certificate !== certificate) {
    imported = { certificate, key: importX509(certificate, "RS256") };
    importedCertificates.set(header.kid, imported);
    imported.key.catch(() => { if (importedCertificates.get(header.kid!) === imported) importedCertificates.delete(header.kid!); });
  }
  const key = await imported.key;
  const result = await jwtVerify(token, key, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });
  if (!result.payload.sub) throw new Error("Firebase token has no subject");
  return result.payload;
}

async function verifyAppCheckToken(token: string, projectNumber: string, appId?: string) {
  const header = decodeProtectedHeader(token);
  if (header.alg !== "RS256" || header.typ !== "JWT") throw new Error("Invalid App Check token header");
  const result = await jwtVerify(token, appCheckKeys, {
    algorithms: ["RS256"],
    audience: `projects/${projectNumber}`,
    issuer: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
  });
  if (appId && result.payload.sub !== appId) throw new Error("App Check app mismatch");
}

export type MarketAuthEnv = Record<string, unknown>;

/**
 * Firebase ID token + member allowlist (+ App Check when required).
 * `local` is the user's own Mac app or `next dev`, where auth is optional.
 */
export async function authorizeMarketRequest(request: Request, rawEnv: MarketAuthEnv, options: { local?: boolean } = {}) {
  const env = rawEnv as Record<string, string | undefined>;
  if (options.local && env.KABUTORA_REQUIRE_AUTH !== "true") return { uid: "local" };
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new MarketAuthUnavailable("authentication_not_configured");
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Authentication required");
  const token = await verifyFirebaseIdToken(authorization.slice(7), projectId);
  const members = configuredMarketMembers(env);
  if (!token.sub || !members.has(token.sub)) throw new Error("Account is not authorized");
  if (env.KABUTORA_REQUIRE_APP_CHECK === "true") {
    const projectNumber = env.FIREBASE_PROJECT_NUMBER;
    const appCheckToken = request.headers.get("X-Firebase-AppCheck");
    if (!projectNumber || !appCheckToken) throw new Error("App verification required");
    await verifyAppCheckToken(appCheckToken, projectNumber, env.FIREBASE_WEB_APP_ID);
  }
  return { uid: token.sub! };
}

export const unauthorizedResponse = (cause?: unknown) => Response.json(
  { error: cause instanceof MarketAuthUnavailable ? "authentication_unavailable" : "unauthorized" },
  { status: cause instanceof MarketAuthUnavailable ? 503 : 401, headers: { "Cache-Control": "no-store", ...(cause instanceof MarketAuthUnavailable ? { "Retry-After": "5" } : {}) } },
);
