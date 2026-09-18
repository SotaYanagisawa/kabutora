import { createRemoteJWKSet, decodeProtectedHeader, importX509, jwtVerify, type JWTPayload } from "jose";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { currentMarketRequestContext } from "./server-market-request-context";

const FIREBASE_CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const appCheckKeys = createRemoteJWKSet(new URL("https://firebaseappcheck.googleapis.com/v1/jwks"));

let certificateCache: { expiresAt: number; values: Record<string, string> } | null = null;

const cacheMaxAge = (header: string | null) => {
  const match = /max-age=(\d+)/u.exec(header ?? "");
  return match ? Number(match[1]) * 1000 : 60 * 60 * 1000;
};

async function getFirebaseCertificate(kid: string) {
  if (!certificateCache || certificateCache.expiresAt <= Date.now()) {
    const response = await fetch(FIREBASE_CERTS_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Firebase authentication keys unavailable");
    certificateCache = {
      values: await response.json() as Record<string, string>,
      expiresAt: Date.now() + cacheMaxAge(response.headers.get("Cache-Control")),
    };
  }
  const certificate = certificateCache.values[kid];
  if (!certificate) throw new Error("Unknown Firebase authentication key");
  return certificate;
}

async function verifyFirebaseIdToken(token: string, projectId: string): Promise<JWTPayload> {
  const header = decodeProtectedHeader(token);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Invalid Firebase token header");
  const key = await importX509(await getFirebaseCertificate(header.kid), "RS256");
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

export async function authorizeMarketRequest(request: Request) {
  const nativeContext = currentMarketRequestContext();
  const cloudflareEnv = nativeContext?.env ?? (await getCloudflareContext({ async: true }).catch(() => null))?.env;
  const env = (cloudflareEnv ?? process.env) as Record<string, string | undefined>;
  const localPrivateMode = !nativeContext && (Boolean(process.env.KABUTORA_LOCAL_VAULT_PATH) || process.env.NODE_ENV === "development");
  if (localPrivateMode && env.KABUTORA_REQUIRE_AUTH !== "true") return { uid: "local" };
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is not configured");
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Authentication required");
  const token = await verifyFirebaseIdToken(authorization.slice(7), projectId);
  const allowedUid = env.KABUTORA_ALLOWED_UID;
  if (!allowedUid || token.sub !== allowedUid) throw new Error("Account is not authorized");
  if (env.KABUTORA_REQUIRE_APP_CHECK === "true") {
    const projectNumber = env.FIREBASE_PROJECT_NUMBER;
    const appCheckToken = request.headers.get("X-Firebase-AppCheck");
    if (!projectNumber || !appCheckToken) throw new Error("App verification required");
    await verifyAppCheckToken(appCheckToken, projectNumber, env.FIREBASE_WEB_APP_ID);
  }
  return { uid: token.sub! };
}

export const unauthorizedResponse = () => Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
