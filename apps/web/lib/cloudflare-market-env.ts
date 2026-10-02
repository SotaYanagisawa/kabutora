import { getCloudflareContext } from "@opennextjs/cloudflare";
import { currentMarketRequestContext } from "./server-market-request-context";

export type D1ResultLike<T = Record<string, unknown>> = {
  success: boolean;
  results?: T[];
  meta?: { changes?: number; rows_read?: number; rows_written?: number };
};

export type D1PreparedStatementLike = {
  bind: (...values: unknown[]) => D1PreparedStatementLike;
  all: <T = Record<string, unknown>>() => Promise<D1ResultLike<T>>;
  first: <T = Record<string, unknown>>(column?: string) => Promise<T | null>;
  run: () => Promise<D1ResultLike>;
};

export type D1DatabaseLike = {
  prepare: (query: string) => D1PreparedStatementLike;
  batch: (statements: D1PreparedStatementLike[]) => Promise<D1ResultLike[]>;
};

export type QueueProducerLike = {
  sendBatch: (messages: Array<{ body: unknown; contentType?: "json" | "text" | "bytes" | "v8" }>) => Promise<void>;
};

export type CoordinatorNamespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> } };

export type MarketWorkerEnv = {
  MARKET_COORDINATOR?: CoordinatorNamespace;
  KABUTORA_MARKET_BACKEND?: string;
  KABUTORA_MARKET_CANARY?: string;
  MARKET_DB?: D1DatabaseLike;
  MARKET_REFRESH_QUEUE?: QueueProducerLike;
};

export async function getMarketCloudflareContext() {
  const context = currentMarketRequestContext() ?? await getCloudflareContext({ async: true });
  return {
    db: (context.env as MarketWorkerEnv).MARKET_DB,
    queue: (context.env as MarketWorkerEnv).MARKET_REFRESH_QUEUE,
    coordinator: (context.env as MarketWorkerEnv).KABUTORA_MARKET_BACKEND === "v2" ? (context.env as MarketWorkerEnv).MARKET_COORDINATOR : undefined,
    ctx: context.ctx,
  };
}
