import fs from "node:fs/promises";
import path from "node:path";

const sourceDir = process.argv[2];
const outputPath = process.argv[3];

if (!sourceDir || !outputPath) {
  throw new Error("Usage: build-seed.mjs <workbook-json-dir> <output.json>");
}

const read = async (name) =>
  JSON.parse(await fs.readFile(path.join(sourceDir, `${name}.json`), "utf8")).values;

const ledgerRows = await read("日本株ログ");

const excelDate = (serial) =>
  new Date(Date.UTC(1899, 11, 30) + Number(serial) * 86_400_000)
    .toISOString()
    .slice(0, 10);

const securityNames = Object.fromEntries(
  ledgerRows
    .slice(1)
    .filter((row) => row[1] && row[2])
    .map((row) => [row[1], row[2]]),
);

const tickers = new Set(
  ledgerRows.slice(1).map((row) => row[1]).filter(Boolean),
);

const securities = [...tickers]
  .sort()
  .map((ticker) => {
    const symbol = ticker.replace(/\.T$/, "");
    return {
      id: `sec-${symbol.toLowerCase()}-xtks`,
      canonicalSymbol: symbol,
      displaySymbol: symbol,
      providerSymbols: { yahoo: ticker },
      name: securityNames[ticker] ?? ticker,
      assetType: ticker === "1540.T" ? "etf" : "stock",
      country: "JP",
      exchangeMic: "XTKS",
      exchangeName: "東京証券取引所",
      currency: "JPY",
      timezone: "Asia/Tokyo",
    };
  });

const securityByTicker = Object.fromEntries(
  securities.map((security) => [security.providerSymbols.yahoo, security]),
);

const accounts = [];
const accountByKey = new Map();
const getAccountId = (broker, nisa) => {
  const normalizedBroker = broker || "現金口座";
  const key = `${normalizedBroker}:${nisa === "Y" ? "NISA" : "特定"}`;
  if (!accountByKey.has(key)) {
    const id = `account-${accountByKey.size + 1}`;
    accountByKey.set(key, id);
    accounts.push({
      id,
      name: `${normalizedBroker} ${nisa === "Y" ? "NISA" : "特定"}`,
      broker: normalizedBroker,
      accountType: nisa === "Y" ? "nisa" : "taxable",
      country: "JP",
      defaultCurrency: "JPY",
    });
  }
  return accountByKey.get(key);
};

const warnings = [];
const transactions = ledgerRows.slice(1).map((row, index) => {
  const [serial, ticker, name, rawType, shares, price, amount, broker, nisa] = row;
  let type = rawType;
  if (rawType === "入金" && ticker && shares && price) {
    type = "TransferIn";
    warnings.push({
      row: index + 4,
      message: "銘柄・数量・取得価額を含む入金を株式の移管入庫として解釈しました",
      ticker,
    });
  } else if (!rawType && ticker && shares && price) {
    type = "Buy";
    warnings.push({
      row: index + 4,
      message: `銘柄情報を含む「${rawType || "空欄"}」を買付として解釈しました`,
      ticker,
    });
  } else if (!rawType && !ticker && amount) {
    type = "入金";
  }

  const mappedType = type === "Buy" ? "BUY" : type === "Sell" ? "SELL" : type === "TransferIn" ? "TRANSFER_IN" : "DEPOSIT";
  const accountId = getAccountId(broker, nisa);
  return {
    id: `tx-${String(index + 1).padStart(4, "0")}`,
    portfolioId: "portfolio-main",
    accountId,
    securityId: ticker ? securityByTicker[ticker]?.id : null,
    type: mappedType,
    tradeDate: `${excelDate(serial)}T06:00:00.000Z`,
    quantity: shares == null ? null : String(shares),
    pricePerShare: price == null ? null : String(price),
    tradeCurrency: "JPY",
    grossAmount: amount == null ? null : String(amount),
    source: "xlsx_import",
    original: {
      sheet: "日本株ログ",
      row: index + 4,
      ticker,
      name,
      action: rawType,
      broker,
      nisa,
    },
    createdAt: `${excelDate(serial)}T06:00:00.000Z`,
    updatedAt: `${excelDate(serial)}T06:00:00.000Z`,
    version: 1,
  };
});

// A small native-USD fixture exercises the same multi-currency path used by
// manually recorded U.S. trades without altering the imported workbook rows.
accounts.push({
  id: "account-5",
  name: "SBI証券 米国株",
  broker: "SBI証券",
  accountType: "taxable",
  country: "US",
  defaultCurrency: "USD",
});
securities.push({
  id: "sec-us-aapl-xnas",
  canonicalSymbol: "AAPL",
  displaySymbol: "AAPL",
  providerSymbols: { yahoo: "AAPL" },
  name: "Apple",
  assetType: "stock",
  country: "US",
  exchangeMic: "XNAS",
  exchangeName: "NASDAQ",
  currency: "USD",
  timezone: "America/New_York",
});
transactions.push(
  {
    id: "fixture-usd-aapl-funding",
    portfolioId: "portfolio-main",
    accountId: "account-5",
    securityId: null,
    type: "DEPOSIT",
    tradeDate: "2025-08-08T13:30:00.000Z",
    quantity: null,
    pricePerShare: null,
    tradeCurrency: "USD",
    grossAmount: "2270.40",
    source: "demo_fixture",
    original: { sheet: "US demo", row: 1, ticker: null, name: null, action: "DEPOSIT", broker: "SBI証券", nisa: "N" },
    createdAt: "2025-08-08T13:30:00.000Z",
    updatedAt: "2025-08-08T13:30:00.000Z",
    version: 1,
  },
  {
    id: "fixture-usd-aapl-buy",
    portfolioId: "portfolio-main",
    accountId: "account-5",
    securityId: "sec-us-aapl-xnas",
    type: "BUY",
    tradeDate: "2025-08-08T13:31:00.000Z",
    quantity: "10",
    pricePerShare: "227.04",
    tradeCurrency: "USD",
    grossAmount: "2270.40",
    source: "demo_fixture",
    original: { sheet: "US demo", row: 2, ticker: "AAPL", name: "Apple", action: "BUY", broker: "SBI証券", nisa: "N" },
    createdAt: "2025-08-08T13:31:00.000Z",
    updatedAt: "2025-08-08T13:31:00.000Z",
    version: 1,
  },
);

const seed = {
  portfolio: {
    id: "portfolio-main",
    name: "メインポートフォリオ",
    baseCurrency: "JPY",
    defaultCostBasisMethod: "AVERAGE",
    includeCash: true,
    includeExtendedHours: false,
  },
  accounts,
  securities,
  transactions,
  importWarnings: warnings,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(seed, null, 2)}\n`);
console.log(
  JSON.stringify({
    transactions: transactions.length,
    securities: securities.length,
    accounts: accounts.length,
    warnings: warnings.length,
  }),
);
