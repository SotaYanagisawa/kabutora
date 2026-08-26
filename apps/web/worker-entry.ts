import openNextWorker, {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
} from "./.open-next/worker.js";

export { BucketCachePurge, DOQueueHandler, DOShardedTagCache };

const FIREBASE_AUTH_HELPER_ORIGIN = "https://kabutora-20260810-7a4e.firebaseapp.com";
const DISALLOWED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
];

async function proxyFirebaseAuthHelper(request: Request) {
  const incomingUrl = new URL(request.url);
  const isAuthHelper = incomingUrl.pathname.startsWith("/__/auth/");
  const isFirebaseConfig = incomingUrl.pathname === "/__/firebase/init.json";
  if (!isAuthHelper && !isFirebaseConfig) return null;

  const upstreamUrl = new URL(incomingUrl.pathname, FIREBASE_AUTH_HELPER_ORIGIN);
  upstreamUrl.search = incomingUrl.search;
  const requestHeaders = new Headers();
  for (const name of ["accept", "accept-language", "content-type", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: requestHeaders,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  for (const name of DISALLOWED_RESPONSE_HEADERS) responseHeaders.delete(name);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const authResponse = await proxyFirebaseAuthHelper(request);
    if (authResponse) return authResponse;
    return openNextWorker.fetch(request, env, ctx);
  },
};
