import openNextWorker, {
  BucketCachePurge,
  DOQueueHandler,
  DOShardedTagCache,
} from "./.open-next/worker.js";
import type { D1DatabaseLike, MarketWorkerEnv } from "./lib/cloudflare-market-env";
import { collectJapannextPts } from "./lib/server-pts-collector";
import { isD1DailyLimitError, isMarketRefreshJob, processMarketRefreshJob, scheduleMarketRefresh } from "./lib/server-market-scheduler";
import { routeMarketRequest } from "./lib/server-market-router";
import type { MarketRequestContext } from "./lib/server-market-request-context";
import { prepareMarketSnapshotResponses } from "./lib/server-market-response-cache";

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
  async fetch(request: Request, env: MarketRequestContext["env"], ctx: MarketRequestContext["ctx"]) {
    const marketResponse = await routeMarketRequest(request, { env, ctx });
    if (marketResponse) return marketResponse;
    const authResponse = await proxyFirebaseAuthHelper(request);
    if (authResponse) return authResponse;
    return openNextWorker.fetch(request, env, ctx);
  },
  async scheduled(controller: { scheduledTime: number; cron?: string }, env: MarketWorkerEnv, ctx: { waitUntil: (promise: Promise<unknown>) => void }) {
    if (!env.MARKET_DB) return;
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(collectJapannextPts(env.MARKET_DB, controller.scheduledTime));
      return;
    }
    if (env.MARKET_REFRESH_QUEUE) {
      ctx.waitUntil(scheduleMarketRefresh(env.MARKET_DB, env.MARKET_REFRESH_QUEUE, controller.scheduledTime));
    }
  },
  async queue(batch: {
    messages: Array<{
      body: unknown;
      ack: () => void;
      retry: (options?: { delaySeconds?: number }) => void;
    }>;
  }, env: MarketWorkerEnv) {
    if (!env.MARKET_DB) {
      for (const message of batch.messages) message.retry({ delaySeconds: 300 });
      return;
    }
    const db: D1DatabaseLike = env.MARKET_DB;
    await Promise.all(batch.messages.map(async (message) => {
      if (!isMarketRefreshJob(message.body)) {
        message.ack();
        return;
      }
      try {
        await processMarketRefreshJob(db, message.body);
        if (message.body.kind === "quotes" || message.body.kind === "benchmarks") {
          await prepareMarketSnapshotResponses(db);
        }
        message.ack();
      } catch (error) {
        // Retrying quota-rejected writes every two minutes builds a backlog
        // that stampedes D1 as soon as the UTC-day allowance resets.
        if (isD1DailyLimitError(error)) message.ack();
        else message.retry({ delaySeconds: 120 });
      }
    }));
  },
};
