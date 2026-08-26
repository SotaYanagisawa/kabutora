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

const normalize = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase("ja")
  .replaceAll("高配当", "好配当")
  .replace(/[\s・･()（）「」『』【】\[\]_-]+/gu, "");

const publicResult = ({ aliases: _aliases, ...result }: CatalogEntry): JapanFundSearchResult => result;

export const featuredJapanFunds = () => CATALOG.map(publicResult);

export function searchKnownJapanFunds(query: string): JapanFundSearchResult[] {
  const needle = normalize(query);
  if (!needle) return featuredJapanFunds();
  return CATALOG.map((entry, order) => {
    const values = [entry.displaySymbol, entry.name, ...entry.aliases].map(normalize);
    const score = values.reduce((best, value) => {
      if (value === needle) return Math.max(best, 100);
      if (value.startsWith(needle)) return Math.max(best, 90);
      if (value.includes(needle)) return Math.max(best, 80);
      if (needle.includes(value)) return Math.max(best, 70);
      return best;
    }, 0);
    return { entry, order, score };
  }).filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ entry }) => publicResult(entry));
}
