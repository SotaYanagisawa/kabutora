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
