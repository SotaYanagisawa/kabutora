import type { Page } from "./strict-fixture";
import demo from "../data/demo-seed.json";
import { Decimal, type MarketBar } from "@kabutora/domain";

export function syntheticPortfolio(securityCount = 20, transactionCount = 1000, days = 1800) {
  const dates = Array.from({ length: days }, (_, index) => new Date(Date.UTC(2021, 8, 1 + index)).toISOString().slice(0, 10));
  const accounts = demo.accounts.map((account, index) => ({ ...account, broker: `合成証券${index + 1}` }));
  const securities = Array.from({ length: securityCount }, (_, index) => {
    const us = index % 2 === 1;
    const symbol = us ? `TEST${index}` : String(1000 + index);
    return { ...demo.securities[us ? 1 : 0], id: us ? `sec-us-${symbol.toLowerCase()}-xnas` : `sec-${symbol}-xtks`, displaySymbol: symbol, canonicalSymbol: symbol, name: `Synthetic ${symbol}`, providerSymbols: { yahoo: us ? symbol : `${symbol}.T` } };
  });
  const transactions = Array.from({ length: transactionCount }, (_, index) => {
    const security = securities[index % securityCount];
    const us = security.currency === "USD";
    const date = dates[us ? days - 80 + Math.floor(index / securityCount) % 60 : Math.floor(index / securityCount) % (days - 1)];
    return { ...demo.transactions[us ? 1 : 0], id: `synthetic-trade-${index}`, securityId: security.id, tradeDate: date, quantity: "0.125", pricePerShare: us ? "20.12" : "1000.12", grossAmount: new Decimal("0.125").mul(us ? "20.12" : "1000.12").toString(), original: { ...demo.transactions[us ? 1 : 0].original, broker: accounts[us ? 1 : 0].broker, row: index + 1 } };
  });
  const bars: MarketBar[] = securities.flatMap((security, index) => dates.map((date, day) => ({ securityId: security.id, date, close: new Decimal(security.currency === "USD" ? "20.12" : "1000.12").plus(new Decimal(day % 21).div(10)).toString(), provider: "synthetic" })));
  for (const date of dates) bars.push({ securityId: "sec-fx-usdjpy", date, close: "150.123", provider: "synthetic" });
  const generatedAt = new Date().toISOString();
  const quotes = [
    ...securities.map((security) => ({ securityId: security.id, symbol: security.displaySymbol, exchangeMic: security.exchangeMic, currency: security.currency, price: security.currency === "USD" ? "22.13" : "1100.23", previousRegularClose: security.currency === "USD" ? "22" : "1100", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "cached", provider: "synthetic", session: "closed", priceType: "official_close", venueCode: security.currency === "USD" ? "US" : "TSE", validationStatus: "valid" })),
    { securityId: "sec-fx-usdjpy", symbol: "USDJPY=X", exchangeMic: "FX", currency: "JPY", price: "150.123", previousRegularClose: "150.00", marketTimestamp: generatedAt, fetchedAt: generatedAt, freshness: "cached", provider: "synthetic", session: "closed", priceType: "official_close", venueCode: "FX", validationStatus: "valid" },
  ];
  return { seed: { ...demo, accounts, securities, transactions }, bars, quotes, generatedAt };
}

export async function installSyntheticPortfolio(page: Page, fixture = syntheticPortfolio()) {
  await page.route("**/api/local/bootstrap", (route) => route.fulfill({ json: fixture.seed }));
  await page.route("**/api/market/quotes", (route) => route.fulfill({ json: { quotes: fixture.quotes, intraday: [], failures: [], coverage: { requested: fixture.quotes.length, returned: fixture.quotes.length }, generatedAt: fixture.generatedAt } }));
  await page.route("**/api/market/history", (route) => route.fulfill({ json: { bars: fixture.bars, corporateActions: [], failures: [], inceptionDates: {}, coverage: { requested: fixture.quotes.length + 1, returned: fixture.quotes.length + 1 }, generatedAt: fixture.generatedAt } }));
  await page.route("**/api/market/benchmarks**", (route) => route.fulfill({ json: { benchmarks: [{ id: "usd-jpy", label: "USD/JPY", value: 150.123, marketTimestamp: fixture.generatedAt }], failures: [] } }));
  return fixture;
}
