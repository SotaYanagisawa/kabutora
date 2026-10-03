export type QuoteSession =
  | "pre_market"
  | "regular"
  | "after_hours"
  | "pts_day"
  | "pts_night"
  | "closed";

export type NormalizedQuote = {
  securityId: string;
  symbol: string;
  exchangeMic: string;
  venueCode: string;
  currency: "JPY" | "USD";
  price: string;
  previousRegularClose?: string;
  marketTimestamp: string;
  fetchedAt: string;
  session: QuoteSession;
  priceType: "last_trade" | "official_close" | "delayed_last" | "manual";
  freshness: "live" | "near_live" | "delayed" | "cached" | "stale" | "manual";
  provider: string;
  validationStatus: "valid" | "suspect" | "rejected";
};

export interface MarketDataProvider {
  readonly id: string;
  getQuote(symbol: string, securityId: string): Promise<NormalizedQuote | null>;
}

export interface PtsProvider {
  getPtsQuote(
    symbol: string,
    securityId: string,
    session: "pts_day" | "pts_night",
  ): Promise<NormalizedQuote | null>;
}

export class NullPtsProvider implements PtsProvider {
  async getPtsQuote() {
    return null;
  }
}

export const PUBLIC_MARKET_RESOURCES = ["quotes", "history", "distributions", "intraday", "catalog"] as const;
export type MarketResource = typeof PUBLIC_MARKET_RESOURCES[number];
export type MarketJobState = "queued" | "running" | "publishing" | "succeeded_changed" | "succeeded_unchanged" | "partial" | "retry_at" | "budget_deferred" | "failed";
export type ProviderCapabilities = {
  quotes: boolean;
  intraday: boolean;
  dailyHistory: boolean;
  distributions: boolean;
  corporateActions: boolean;
  delaySeconds: number | null;
  permittedGroupUse: "confirmed" | "unverified";
};
export type PublicMarketManifest = { resource: MarketResource; revision: string; chunk_count: number; published_at: string; chunk_keys?:string[] };
/** Versioned immutable transport; validate unknown data before allocating chunks. */
export function parsePublicMarketManifest(value: unknown): PublicMarketManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("market_manifest_invalid");
  const record=value as Record<string,unknown>;
  if (!PUBLIC_MARKET_RESOURCES.includes(record.resource as MarketResource)
    || typeof record.revision !== "string" || !/^[a-f0-9]{64}$/u.test(record.revision)
    || typeof record.chunk_count !== "number" || !Number.isInteger(record.chunk_count) || record.chunk_count<1 || record.chunk_count>5000
    || typeof record.published_at !== "string" || !Number.isFinite(Date.parse(record.published_at))) throw new Error("market_manifest_invalid");
  if(record.chunk_keys!==undefined && (!Array.isArray(record.chunk_keys) || record.chunk_keys.length!==record.chunk_count || !record.chunk_keys.every(key=>typeof key==="string" && /^[a-f0-9]{64}$/u.test(key)))) throw new Error("market_manifest_invalid");
  return { resource:record.resource as MarketResource,revision:record.revision,chunk_count:record.chunk_count,published_at:record.published_at,...(record.chunk_keys===undefined?{}:{chunk_keys:record.chunk_keys as string[]}) };
}
