import { buildSecuritySearchIndex, searchSecurityIndex } from "./security-search";

export type JapanFundSearchResult = {
  id: string;
  displaySymbol: string;
  name: string;
  assetType: "fund";
  country: "JP" | "US";
  exchangeMic: "JPFD" | "XFND";
  exchangeName: string;
  exchangeLabel: string;
  currency: "JPY" | "USD";
  timezone: "Asia/Tokyo";
  priceUnit: "1" | "10000";
  providerSymbols: { yahoo?: string; monex?: string };
};

type CatalogEntry = JapanFundSearchResult & { aliases: readonly string[] };

const fund = (code: string, name: string, aliases: readonly string[]): CatalogEntry => ({
  id: `sec-jp-fund-${code.toLowerCase()}`,
  displaySymbol: code,
  name,
  assetType: "fund",
  country: "JP",
  exchangeMic: "JPFD",
  exchangeName: "日本の投資信託",
  exchangeLabel: "投資信託",
  currency: "JPY",
  timezone: "Asia/Tokyo",
  priceUnit: "10000",
  providerSymbols: { yahoo: code },
  aliases,
});

const CATALOG: readonly CatalogEntry[] = [
  fund("48314059", "ブラックロック 世界好配当株式オープン（世界の息吹）", [
    "ブラックロック 世界好配当株式オープン",
    "ブラックロック世界好配当株式オープン",
    "ブラックロック 世界高配当株式オープン",
    "ブラックロック世界高配当株式オープン",
    "世界の息吹",
    "世界の息吹（日本円）",
  ]),
  fund("02311886", "インデックスファンド225", ["日興 インデックスファンド225", "日経225"]),
  fund("02314143", "インデックスファンドNYダウ30（アメリカ株式）", [
    "インデックスファンドNYダウ30(アメリカ株式)",
    "NYダウ30",
  ]),
  {
    id: "sec-foreign-fund-21070062",
    displaySymbol: "21070062",
    name: "ジャナス・フォーティ・ファンド クラスA（米ドル）",
    assetType: "fund",
    country: "US",
    exchangeMic: "XFND",
    exchangeName: "外国籍投資信託",
    exchangeLabel: "外国籍投資信託",
    currency: "USD",
    timezone: "Asia/Tokyo",
    priceUnit: "1",
    providerSymbols: { monex: "0162" },
    aliases: ["ジャナス・フォーティA米ドル", "ジャナスフォーティA米ドル", "ジャナス・フォーティ・ファンド（米ドル）A", "ノアの箱舟 厳選型"],
  },
];

const publicResult = ({ aliases: _aliases, ...result }: CatalogEntry): JapanFundSearchResult => result;
const SEARCH_INDEX = buildSecuritySearchIndex(CATALOG);

export const featuredJapanFunds = () => CATALOG.map(publicResult);

export function searchKnownJapanFunds(query: string): JapanFundSearchResult[] {
  if (!query.trim()) return featuredJapanFunds();
  return searchSecurityIndex(SEARCH_INDEX, query, CATALOG.length).map(publicResult);
}
