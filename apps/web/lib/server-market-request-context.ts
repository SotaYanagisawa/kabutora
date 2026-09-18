import { AsyncLocalStorage } from "node:async_hooks";
import type { MarketWorkerEnv } from "./cloudflare-market-env";

export type MarketRequestContext = {
  env: MarketWorkerEnv & {
    FIREBASE_PROJECT_ID?: string;
    FIREBASE_PROJECT_NUMBER?: string;
    FIREBASE_WEB_APP_ID?: string;
    KABUTORA_ALLOWED_UID?: string;
    KABUTORA_REQUIRE_AUTH?: string;
    KABUTORA_REQUIRE_APP_CHECK?: string;
  };
  ctx: { waitUntil: (promise: Promise<unknown>) => void };
};

// Bindings belong to the invocation, never a mutable process-wide environment.
const requests = new AsyncLocalStorage<MarketRequestContext>();
export const currentMarketRequestContext = () => requests.getStore();
export function withMarketRequestContext<T>(context: MarketRequestContext, task: () => T): T {
  return requests.run(context, task);
}
