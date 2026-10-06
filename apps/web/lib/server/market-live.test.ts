import { describe, expect, it } from "vitest";
import { unpackHistory } from "../market/market-wire";
import { MarketService, MemoryMarketStore } from "./market-service";
import { searchSecurities } from "./market-search";

/** Real providers (network). Run with `pnpm check:live`. */
const live = process.env.KABUTORA_LIVE === "1";

describe.skipIf(!live)("live market providers", () => {
  it("serves quotes, intraday, fund NAVs and split-consistent history", { timeout: 120_000 }, async () => {
    const service = new MarketService(new MemoryMarketStore());
    await service.register(["sec-285a-xtks", "sec-8316", "sec-us-nvda-xnas", "sec-jp-fund-48314059", "sec-9984"]);
    let started = performance.now();
    const snapshot = await service.snapshot();
    console.log(`cold snapshot ${Math.round(performance.now() - started)} ms, ${snapshot.quotes.length} quotes, ${Object.keys(snapshot.intraday ?? {}).length} intraday`);
    for (const key of ["sec-285a", "sec-8316", "sec-us-nvda", "sec-9984", "sec-fx-usdjpy"]) expect(snapshot.quotes.find((quote) => quote.key === key)?.price).toBeGreaterThan(0);
    expect(snapshot.benchmarks.length).toBeGreaterThanOrEqual(5);

    started = performance.now();
    let history = await service.history("2024-01-01");
    for (let attempt = 0; attempt < 5 && history.pending.length; attempt += 1) history = await service.history("2024-01-01");
    console.log(`history ${Math.round(performance.now() - started)} ms, ${Object.keys(history.records).length} records, pending ${history.pending.join(",")}`);
    const kioxia = unpackHistory("sec-285a", history.records["sec-285a"]);
    expect(kioxia.splits).toContainEqual({ date: "2026-09-29", ratio: 3 });
    const smfg = unpackHistory("sec-8316", history.records["sec-8316"]);
    expect(smfg.splits).toContainEqual({ date: "2026-09-29", ratio: 2 });
    expect(smfg.dividends.find((item) => item.date === "2026-09-29")?.amount).toBeCloseTo(45, 6);
    const fund = unpackHistory("sec-jp-fund-48314059", history.records["sec-jp-fund-48314059"]);
    expect(fund.dates.length).toBeGreaterThan(200);
    expect(fund.dividends.length).toBeGreaterThan(10);
    const fx = unpackHistory("sec-fx-usdjpy", history.records["sec-fx-usdjpy"]);
    expect(fx.closes.at(-1)).toBeGreaterThan(80);

    started = performance.now();
    const warm = await service.snapshot({ intradayRevision: snapshot.intradayRevision });
    console.log(`warm snapshot ${Math.round(performance.now() - started)} ms, intraday ${warm.intraday ? "resent" : "omitted"}`);

    const response = await searchSecurities(new Request("http://local/search", { method: "POST", body: JSON.stringify({ q: "キオクシア" }) }));
    const { results } = await response.json() as { results: Array<{ id: string }> };
    expect(results.map((result) => result.id)).toContain("sec-285a-xtks");
  });
});
