import { boundedMarketCacheSet } from "./server/market/bounded-cache";
import { providerFetch } from "./server/market/provider-fetch";
import type { MarketBar, MarketQuote } from "@kabutora/domain";

type ChartPoint = { dt?: number; p?: number; pd?: number };
type ParsedFundPage = { bars: MarketBar[]; latestPrice: number; previousPrice: number; priceDate: string };
type CacheEntry = { value: ParsedFundPage; expiresAt: number; staleUntil: number };

const PRODUCTS = {
  "0162": {
    name: "ジャナス・フォーティ・ファンド クラスA（米ドル）",
    nickname: "ノアの箱舟 厳選型",
  },
} as const;

const pageCache = new Map<string, CacheEntry>();
const USER_AGENT = "Kabutora/1.0 personal-portfolio-tracker";
const FUND_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokyoDate(timestamp: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export function parseMonexForeignFundPage(html: string, securityId: string): ParsedFundPage | null {
  const match = /var chartData = (\[[\s\S]*?\]);/u.exec(html);
  if (!match) return null;
  let points: ChartPoint[];
  try {
    points = JSON.parse(match[1]) as ChartPoint[];
  } catch {
    return null;
  }
  if (!Array.isArray(points)) return null;
  const byDate = new Map<string, MarketBar>();
  for (const point of points) {
    if (!point || typeof point.dt !== "number" || !Number.isFinite(point.dt) || typeof point.p !== "number" || !Number.isFinite(point.p) || point.p <= 0) continue;
    const date = tokyoDate(point.dt);
    if (!/^20\d{2}-\d{2}-\d{2}$/u.test(date)) continue;
    byDate.set(date, { securityId, date, close: String(point.p), provider: "monex_foreign_fund_unofficial" });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 2) return null;
  const latest = bars.at(-1)!;
  const previous = bars.at(-2)!;
  return { bars, latestPrice: Number(latest.close), previousPrice: Number(previous.close), priceDate: latest.date };
}

async function fetchFundPage(providerCode: string, securityId: string, force: boolean) {
  if (!(providerCode in PRODUCTS)) throw new Error("Unsupported foreign fund code");
  const cached = pageCache.get(providerCode);
  if (!force && cached && cached.expiresAt > Date.now()) return { page: cached.value, cacheState: "memory" as const };
  try {
    const response = await providerFetch(`https://fund.monex.co.jp/detail/${encodeURIComponent(providerCode)}`, {
      cache: "no-store",
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Monex returned ${response.status}`);
    const page = parseMonexForeignFundPage(await response.text(), securityId);
    if (!page) throw new Error("foreign fund NAV history unavailable");
    boundedMarketCacheSet(pageCache, providerCode, { value: page, expiresAt: Date.now() + FUND_TTL_MS, staleUntil: Date.now() + STALE_TTL_MS });
    return { page, cacheState: "network" as const };
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) return { page: cached.value, cacheState: "stale" as const };
    throw error;
  }
}

export async function getMonexForeignFundQuoteBundle(providerCode: string, securityId: string, force = false) {
  const product = PRODUCTS[providerCode as keyof typeof PRODUCTS];
  if (!product) throw new Error("Unsupported foreign fund code");
  const { page, cacheState } = await fetchFundPage(providerCode, securityId, force);
  const marketTimestamp = new Date(`${page.priceDate}T15:00:00+09:00`).toISOString();
  const quote: MarketQuote = {
    price: String(page.latestPrice),
    previousRegularClose: String(page.previousPrice),
    dayOpen: String(page.latestPrice),
    dayHigh: String(page.latestPrice),
    dayLow: String(page.latestPrice),
    marketTimestamp,
    fetchedAt: new Date().toISOString(),
    freshness: cacheState === "stale" ? "stale" : cacheState === "memory" ? "cached" : "delayed",
    provider: "monex_foreign_fund_unofficial",
    session: "closed",
    priceType: "official_close",
    venueCode: "FUND",
    validationStatus: Math.abs(page.latestPrice / page.previousPrice - 1) > 0.5 ? "suspect" : "valid",
  };
  return {
    quote,
    intraday: page.bars.slice(-30).map((bar) => ({
      securityId,
      timestamp: `${bar.date}T15:00:00+09:00`,
      price: bar.close,
      provider: bar.provider,
    })),
    shortName: product.name,
    longName: `${product.name}（愛称：${product.nickname}）`,
    exchangeLabel: "外国籍投資信託",
  };
}

export async function getMonexForeignFundHistory(providerCode: string, securityId: string, period1: number, period2: number, force = false) {
  const { page, cacheState } = await fetchFundPage(providerCode, securityId, force);
  const from = new Date(period1 * 1000).toISOString().slice(0, 10);
  const to = new Date(period2 * 1000).toISOString().slice(0, 10);
  const bars = page.bars.filter((bar) => bar.date >= from && bar.date <= to);
  if (!bars.length) throw new Error(`${providerCode}: no usable foreign fund history`);
  return { bars, corporateActions: [], inceptionDate: page.bars[0]?.date, cacheState };
}
