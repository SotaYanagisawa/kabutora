/**
 * Deterministic stand-in for the market providers (Yahoo, Yahoo! ファイナンス, Japannext), used by the
 * market unit tests and by the workerd runtime test. Production code never imports this module.
 */

export type FakeSecurity = {
  currency: "JPY" | "USD";
  zone: "Asia/Tokyo" | "America/New_York";
  /** Closes in today's share units. */
  closes: Array<[date: string, close: number]>;
  splits?: Array<[date: string, numerator: number, denominator: number]>;
  dividends?: Array<[date: string, amount: number]>;
  price: number;
  previousClose: number;
  name?: string;
  /** Unix seconds of the last regular-session trade; defaults to two minutes ago. */
  time?: number;
};

export type FakeFund = { name: string; closes: Array<[date: string, close: number]>; distributions?: Array<[date: string, amount: number]> };

export type FakeUpstreamOptions = {
  now: () => number;
  securities: Record<string, FakeSecurity>;
  funds?: Record<string, FakeFund>;
  /** Japannext last prices (or last price and cumulative volume) by 4-character code. Read on every request. */
  pts?: Record<string, number | { last: number; volume: number }>;
  /** Last-Modified of the Japannext file, unix ms; defaults to 30 s ago. */
  ptsModifiedAt?: () => number;
  latencyMs?: number;
};

const HOSTS = new Set(["query1.finance.yahoo.com", "query2.finance.yahoo.com", "finance.yahoo.co.jp", "www.japannext.co.jp", "www.blackrock.com", "fund.monex.co.jp"]);

/** 09:00 JST for Tokyo listings, 09:30 New York (13:30 UTC, DST ignored) for US listings. */
const barTime = (date: string, zone: FakeSecurity["zone"]) => Date.parse(`${date}T${zone === "Asia/Tokyo" ? "00:00" : "13:30"}:00Z`) / 1000;

export function createFakeUpstream(options: FakeUpstreamOptions) {
  const state = { calls: 0, fail: false, latencyMs: options.latencyMs ?? 0, byPath: new Map<string, number>() };
  const count = (key: string) => state.byPath.set(key, (state.byPath.get(key) ?? 0) + 1);

  function spark(symbols: string[], range: string) {
    const now = Math.floor(options.now() / 1000);
    return {
      spark: {
        result: symbols.flatMap((symbol) => {
          const security = options.securities[symbol];
          if (!security) return [];
          const step = range === "5d" ? 900 : 300;
          const points = range === "5d" ? 40 : 12;
          const last = security.time ?? now - 120;
          const timestamp = Array.from({ length: points }, (_, index) => last - (points - 1 - index) * step);
          return [{
            symbol,
            response: [{
              meta: {
                currency: security.currency,
                shortName: security.name ?? symbol,
                regularMarketPrice: security.price,
                regularMarketTime: last,
                previousClose: security.previousClose,
                chartPreviousClose: security.previousClose,
                exchangeTimezoneName: security.zone,
                currentTradingPeriod: { regular: { start: now - 30_000, end: now - 60 } },
              },
              timestamp,
              indicators: { quote: [{ close: timestamp.map((_, index) => (index === points - 1 ? security.price : security.previousClose + ((security.price - security.previousClose) * index) / points)) }] },
            }],
          }];
        }),
      },
    };
  }

  function chart(symbol: string, period1: number, period2: number) {
    const security = options.securities[symbol];
    if (!security) return Response.json({ chart: { result: null, error: { description: "No data found" } } }, { status: 404 });
    const inRange = (date: string) => { const time = barTime(date, security.zone); return time >= period1 && time <= period2; };
    const closes = security.closes.filter(([date]) => inRange(date));
    const events = {
      splits: Object.fromEntries((security.splits ?? []).filter(([date]) => inRange(date)).map(([date, numerator, denominator]) => [String(barTime(date, security.zone)), { date: barTime(date, security.zone), numerator, denominator }])),
      dividends: Object.fromEntries((security.dividends ?? []).filter(([date]) => inRange(date)).map(([date, amount]) => [String(barTime(date, security.zone)), { date: barTime(date, security.zone), amount }])),
    };
    return Response.json({
      chart: {
        result: [{
          meta: { currency: security.currency, exchangeTimezoneName: security.zone },
          timestamp: closes.map(([date]) => barTime(date, security.zone)),
          indicators: { quote: [{ close: closes.map(([, close]) => close) }] },
          events,
        }],
      },
    });
  }

  const compact = (date: string) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

  async function handle(url: URL): Promise<Response> {
    if (url.hostname.endsWith("finance.yahoo.com")) {
      if (url.pathname === "/v7/finance/spark") {
        count(`spark:${url.searchParams.get("range")}`);
        return Response.json(spark(url.searchParams.get("symbols")!.split(","), url.searchParams.get("range") ?? "1d"));
      }
      const match = /^\/v8\/finance\/chart\/(.+)$/u.exec(url.pathname);
      if (match) {
        const symbol = decodeURIComponent(match[1]);
        count(`chart:${symbol}`);
        return chart(symbol, Number(url.searchParams.get("period1")), Number(url.searchParams.get("period2")));
      }
      if (url.pathname === "/v1/finance/search") return Response.json({ quotes: [] });
    }
    if (url.hostname === "finance.yahoo.co.jp") {
      if (url.pathname === "/quote/998405.T") {
        count("topix");
        return new Response('<script>{"mainDomesticIndexPriceBoard":{"price":"3,000.5","changePriceRate":"+0.10","japanUpdateTime":"15:30"}}</script>');
      }
      const page = /^\/quote\/([0-9A-Z]{8})\/(chart|dividendinfo)$/u.exec(url.pathname);
      const fund = page ? options.funds?.[page[1]] : undefined;
      if (page && fund && page[2] === "chart") {
        count(`fund-page:${page[1]}`);
        return new Response(`<script>self.__next_f.push([1,"{\\"priceBoard\\":{\\"code\\":\\"${page[1]}\\",\\"name\\":\\"${fund.name}\\"},\\"jwtToken\\":\\"token-${page[1]}\\"}"])</script>`, {
          headers: { "Set-Cookie": "A=fake; path=/" },
        });
      }
      if (page && fund && page[2] === "dividendinfo") {
        count(`fund-dividends:${page[1]}`);
        return new Response((fund.distributions ?? []).map(([date, amount]) => `\\"date\\":\\"${date.replaceAll("-", "/")}\\",\\"price\\":\\"${amount}\\"`).join(","));
      }
      const history = /\/fund\/chart\/history\/([0-9A-Z]{8})$/u.exec(url.pathname);
      const historyFund = history ? options.funds?.[history[1]] : undefined;
      if (history && historyFund) {
        count(`fund-history:${history[1]}`);
        if (url.searchParams.get("timeFrame") !== "daily") return Response.json({ error: [{ message: "bad request" }] }, { status: 400 });
        const from = compact(url.searchParams.get("fromDate")!);
        const to = compact(url.searchParams.get("toDate")!);
        return Response.json({ priceHistories: historyFund.closes.filter(([date]) => date >= from && date <= to).map(([baseDate, closePrice]) => ({ baseDate, closePrice })) });
      }
    }
    if (url.hostname === "www.japannext.co.jp") {
      count("pts");
      const rows = Object.entries(options.pts ?? {}).map(([code, value], index) => {
        const { last, volume } = typeof value === "number" ? { last: value, volume: 1_200 } : value;
        return `mdata[ ${index} ] = [ "${code}", "", "", "", "${last}", "${last}", "${last}", "${last}", "${volume}" ];`;
      });
      return new Response(rows.join("\n"), { headers: { "Last-Modified": new Date(options.ptsModifiedAt?.() ?? options.now() - 30_000).toUTCString() } });
    }
    return new Response("not found", { status: 404 });
  }

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!HOSTS.has(url.hostname)) throw new Error(`unexpected upstream ${url.hostname}`);
    state.calls += 1;
    if (state.latencyMs) await new Promise((resolve) => setTimeout(resolve, state.latencyMs));
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (state.fail) throw new Error("synthetic_upstream_outage");
    return handle(url);
  };

  return { fetch, state, hosts: HOSTS };
}

/** Weekday dates from `from` to `to`, inclusive. */
export function weekdays(from: string, to: string) {
  const dates: string[] = [];
  for (const cursor = new Date(`${from}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}
