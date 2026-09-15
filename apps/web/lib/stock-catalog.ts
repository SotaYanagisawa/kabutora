import {
  buildSecuritySearchIndex,
  searchSecurityIndex,
  type SecuritySearchIndex,
} from "./security-search";

export type CatalogSecurity = {
  id: string;
  displaySymbol: string;
  name: string;
  assetType: "stock" | "etf" | "fund" | "index";
  country: "JP" | "US";
  exchangeMic: "XTKS" | "XNYS" | "XNAS" | "XAMS" | "ARCX" | "BATS" | "XIND" | "JPFD" | "XFND";
  exchangeLabel: string;
  currency: "JPY" | "USD";
  providerSymbols: { yahoo?: string; monex?: string };
  aliases?: readonly string[];
  readingKana?: string;
};

// Compact tuple format: [symbol, name, aliasesStr, kana, assetType, country, exchangeMic, exchangeLabel, currency, yahooProviderSymbol]
// assetType: 0=stock, 1=etf, 2=fund, 3=index
type CompactTuple = [
  string, // 0: symbol
  string, // 1: name
  string, // 2: aliases comma separated
  string, // 3: reading (hiragana/katakana)
  0 | 1 | 2 | 3, // 4: assetType
  "JP" | "US", // 5: country
  "XTKS" | "XNYS" | "XNAS" | "XAMS" | "ARCX" | "BATS" | "XIND" | "JPFD" | "XFND", // 6: exchangeMic
  string, // 7: exchangeLabel
  "JPY" | "USD", // 8: currency
  string?, // 9: yahooProviderSymbol optional
];

const ASSET_TYPES: Array<"stock" | "etf" | "fund" | "index"> = ["stock", "etf", "fund", "index"];

const RAW_STOCK_CATALOG: CompactTuple[] = [
  // --- Major Japanese Stocks (TSE Prime / Large Cap / Popular) ---
  ["7203", "トヨタ自動車", "トヨタ,TOYOTA", "とよたじどうしゃ トヨタ", 0, "JP", "XTKS", "東証P", "JPY", "7203.T"],
  ["9984", "ソフトバンクグループ", "SBG,SoftBank Group", "そふとばんくぐるーぷ ソフトバンク", 0, "JP", "XTKS", "東証P", "JPY", "9984.T"],
  ["6758", "ソニーグループ", "ソニー,SONY", "そにーぐるーぷ ソニー", 0, "JP", "XTKS", "東証P", "JPY", "6758.T"],
  ["8035", "東京エレクトロン", "TEL,Tokyo Electron", "とうきょうえれくとろん 東エレク", 0, "JP", "XTKS", "東証P", "JPY", "8035.T"],
  ["6857", "アドバンテスト", "Advantest", "あどばんてすと", 0, "JP", "XTKS", "東証P", "JPY", "6857.T"],
  ["6501", "日立製作所", "日立,Hitachi", "ひたちせいさくしょ ひたち", 0, "JP", "XTKS", "東証P", "JPY", "6501.T"],
  ["9432", "日本電信電話", "NTT", "にっぽんでんしんでんわ えぬてぃーてぃー", 0, "JP", "XTKS", "東証P", "JPY", "9432.T"],
  ["8306", "三菱UFJフィナンシャル・グループ", "MUFG,三菱UFJ", "みつびしゆーえふじぇい", 0, "JP", "XTKS", "東証P", "JPY", "8306.T"],
  ["8316", "三井住友フィナンシャルグループ", "SMFG,三井住友FG,三井住友銀行", "みついすみとも", 0, "JP", "XTKS", "東証P", "JPY", "8316.T"],
  ["8411", "みずほフィナンシャルグループ", "みずほFG,みずほ銀行", "みずほふぃなんしゃるぐるーぷ", 0, "JP", "XTKS", "東証P", "JPY", "8411.T"],
  ["7974", "任天堂", "Nintendo", "にんてんどう ニンテンドー", 0, "JP", "XTKS", "東証P", "JPY", "7974.T"],
  ["9983", "ファーストリテイリング", "ユニクロ,Fast Retailing,UNIQLO", "ふぁーすとりていりんぐ ゆにくろ", 0, "JP", "XTKS", "東証P", "JPY", "9983.T"],
  ["4063", "信越化学工業", "信越化", "しんえつかがくこうぎょう", 0, "JP", "XTKS", "東証P", "JPY", "4063.T"],
  ["6098", "リクルートホールディングス", "リクルート,Recruit", "りくるーとほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "6098.T"],
  ["4568", "第一三共", "Daiichi Sankyo", "だいいちさんきょう", 0, "JP", "XTKS", "東証P", "JPY", "4568.T"],
  ["4519", "中外製薬", "Chugai", "ちゅうがいせいやく", 0, "JP", "XTKS", "東証P", "JPY", "4519.T"],
  ["6367", "ダイキン工業", "ダイキン,Daikin", "だいきんこうぎょう", 0, "JP", "XTKS", "東証P", "JPY", "6367.T"],
  ["7741", "HOYA", "ホヤ", "ほや ホヤ", 0, "JP", "XTKS", "東証P", "JPY", "7741.T"],
  ["6594", "ニデック", "日本電産,Nidec", "にでっく にほんでんさん", 0, "JP", "XTKS", "東証P", "JPY", "6594.T"],
  ["7267", "本田技研工業", "ホンダ,Honda", "ほんだぎけんこうぎょう ホンダ", 0, "JP", "XTKS", "東証P", "JPY", "7267.T"],
  ["6920", "レーザーテック", "Lasertec", "れーざーてっく", 0, "JP", "XTKS", "東証P", "JPY", "6920.T"],
  ["8058", "三菱商事", "Mitsubishi Corp", "みつびししょうじ", 0, "JP", "XTKS", "東証P", "JPY", "8058.T"],
  ["8001", "伊藤忠商事", "伊藤忠,ITOCHU", "いとうちゅうしょうじ", 0, "JP", "XTKS", "東証P", "JPY", "8001.T"],
  ["8031", "三井物産", "Mitsui", "みついぶっさん", 0, "JP", "XTKS", "東証P", "JPY", "8031.T"],
  ["8002", "丸紅", "Marubeni", "まるべに", 0, "JP", "XTKS", "東証P", "JPY", "8002.T"],
  ["8053", "住友商事", "Sumitomo Corp", "すみともしょうじ", 0, "JP", "XTKS", "東証P", "JPY", "8053.T"],
  ["7011", "三菱重工業", "三菱重工,MHI", "みつびしじゅうこうぎょう", 0, "JP", "XTKS", "東証P", "JPY", "7011.T"],
  ["7012", "川崎重工業", "川重,KHI", "かわさきじゅうこうぎょう", 0, "JP", "XTKS", "東証P", "JPY", "7012.T"],
  ["7013", "IHI", "石川島播磨重工業", "あいえいちあい いしかわじまはりま", 0, "JP", "XTKS", "東証P", "JPY", "7013.T"],
  ["6702", "富士通", "Fujitsu", "ふじつう", 0, "JP", "XTKS", "東証P", "JPY", "6702.T"],
  ["6701", "日本電気", "NEC", "にっぽんでんき エヌイーシー", 0, "JP", "XTKS", "東証P", "JPY", "6701.T"],
  ["9433", "KDDI", "au", "けーでぃーでぃーあい エーユー", 0, "JP", "XTKS", "東証P", "JPY", "9433.T"],
  ["9434", "ソフトバンク", "SoftBank,SB", "そふとばんく", 0, "JP", "XTKS", "東証P", "JPY", "9434.T"],
  ["4661", "オリエンタルランド", "ディズニー,OLC", "おりえんたるらんど でぃずにー", 0, "JP", "XTKS", "東証P", "JPY", "4661.T"],
  ["3382", "セブン＆アイ・ホールディングス", "セブンイレブン,7&i", "せぶんあんどあいほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "3382.T"],
  ["2914", "日本たばこ産業", "JT", "にほんたばこさんぎょう じぇいてぃー", 0, "JP", "XTKS", "東証P", "JPY", "2914.T"],
  ["8766", "東京海上ホールディングス", "東京海上日動,Tokio Marine", "とうきょうかいじょうほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "8766.T"],
  ["5401", "日本製鉄", "新日鉄,Nippon Steel", "にっぽんせいてつ", 0, "JP", "XTKS", "東証P", "JPY", "5401.T"],
  ["6981", "村田製作所", "村田,Murata", "むらたせいさくしょ", 0, "JP", "XTKS", "東証P", "JPY", "6981.T"],
  ["6954", "ファナック", "FANUC", "ふぁなっく", 0, "JP", "XTKS", "東証P", "JPY", "6954.T"],
  ["7751", "キヤノン", "Canon", "きゃのん キヤノン", 0, "JP", "XTKS", "東証P", "JPY", "7751.T"],
  ["4502", "武田薬品工業", "武田,Takeda", "たけだやくひんこうぎょう", 0, "JP", "XTKS", "東証P", "JPY", "4502.T"],
  ["4503", "アステラス製薬", "Astellas", "あすてらすせいやく", 0, "JP", "XTKS", "東証P", "JPY", "4503.T"],
  ["4901", "富士フイルムホールディングス", "富士フイルム,Fujifilm", "ふじふいるむほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "4901.T"],
  ["4911", "資生堂", "Shiseido", "しせいどう", 0, "JP", "XTKS", "東証P", "JPY", "4911.T"],
  ["2802", "味の素", "Ajinomoto", "あじのもと", 0, "JP", "XTKS", "東証P", "JPY", "2802.T"],
  ["2502", "アサヒグループホールディングス", "アサヒビール,Asahi", "あさひぐるーぷほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "2502.T"],
  ["2503", "キリンホールディングス", "キリンビール,Kirin", "きりんほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "2503.T"],
  ["9101", "日本郵船", "NYK", "にっぽんゆうせん", 0, "JP", "XTKS", "東証P", "JPY", "9101.T"],
  ["9104", "商船三井", "MOL", "しょうせんみつい", 0, "JP", "XTKS", "東証P", "JPY", "9104.T"],
  ["9107", "川崎汽船", "K-Line", "かわさききせん", 0, "JP", "XTKS", "東証P", "JPY", "9107.T"],
  ["6301", "小松製作所", "コマツ,Komatsu", "こまつせいさくしょ コマツ", 0, "JP", "XTKS", "東証P", "JPY", "6301.T"],
  ["6503", "三菱電機", "Mitsubishi Electric", "みつびしでんき", 0, "JP", "XTKS", "東証P", "JPY", "6503.T"],
  ["6752", "パナソニック ホールディングス", "パナソニック,Panasonic", "ぱなそにっくほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "6752.T"],
  ["7201", "日産自動車", "日産,Nissan", "にっさんじどうしゃ ニッサン", 0, "JP", "XTKS", "東証P", "JPY", "7201.T"],
  ["7270", "SUBARU", "スバル,富士重工", "すばる スバル", 0, "JP", "XTKS", "東証P", "JPY", "7270.T"],
  ["7269", "スズキ", "Suzuki", "すずき スズキ", 0, "JP", "XTKS", "東証P", "JPY", "7269.T"],
  ["7202", "いすゞ自動車", "いすゞ,Isuzu", "いすずじどうしゃ", 0, "JP", "XTKS", "東証P", "JPY", "7202.T"],
  ["7733", "オリンパス", "Olympus", "おりんぱす", 0, "JP", "XTKS", "東証P", "JPY", "7733.T"],
  ["4755", "楽天グループ", "楽天,Rakuten", "らくてんぐるーぷ", 0, "JP", "XTKS", "東証P", "JPY", "4755.T"],
  ["4689", "LINEヤフー", "ヤフー,Yahoo,LINE", "らいんやふー やふー", 0, "JP", "XTKS", "東証P", "JPY", "4689.T"],
  ["4385", "メルカリ", "Mercari", "めるかり", 0, "JP", "XTKS", "東証P", "JPY", "4385.T"],
  ["3659", "ネクソン", "Nexon", "ねくそん", 0, "JP", "XTKS", "東証P", "JPY", "3659.T"],
  ["9684", "スクウェア・エニックス・ホールディングス", "スクエニ,Square Enix", "すくうぇあえにっくす", 0, "JP", "XTKS", "東証P", "JPY", "9684.T"],
  ["9766", "コナミグループ", "コナミ,Konami", "こなみぐるーぷ", 0, "JP", "XTKS", "東証P", "JPY", "9766.T"],
  ["2432", "ディー・エヌ・エー", "DeNA", "でぃーえぬえー", 0, "JP", "XTKS", "東証P", "JPY", "2432.T"],
  ["1605", "INPEX", "国際石油開発帝石", "いんぺっくす こくさいせきゆ", 0, "JP", "XTKS", "東証P", "JPY", "1605.T"],
  ["5020", "ENEOSホールディングス", "エネオス,ENEOS", "えねおすほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "5020.T"],
  ["5713", "住友金属鉱山", "住友鉱", "すみともきんぞくこうざん", 0, "JP", "XTKS", "東証P", "JPY", "5713.T"],
  ["5802", "住友電気工業", "住友電工", "すみともでんきこうぎょう", 0, "JP", "XTKS", "東証P", "JPY", "5802.T"],
  ["6178", "日本郵政", "ゆうちょ,郵便局,Japan Post", "にっぽんゆうせい", 0, "JP", "XTKS", "東証P", "JPY", "6178.T"],
  ["7182", "ゆうちょ銀行", "Japan Post Bank", "ゆうちょぎんこう", 0, "JP", "XTKS", "東証P", "JPY", "7182.T"],
  ["7181", "かんぽ生命保険", "Japan Post Insurance", "かんぽせいめいほけん", 0, "JP", "XTKS", "東証P", "JPY", "7181.T"],
  ["8604", "野村ホールディングス", "野村證券,Nomura", "のむらほーるでぃんぐす", 0, "JP", "XTKS", "東証P", "JPY", "8604.T"],
  ["8601", "大和証券グループ本社", "大和証券,Daiwa", "だいわしょうけん", 0, "JP", "XTKS", "東証P", "JPY", "8601.T"],
  ["8750", "第一生命ホールディングス", "第一生命,Dai-ichi Life", "だいいちせいめい", 0, "JP", "XTKS", "東証P", "JPY", "8750.T"],
  ["8725", "MS&ADインシュアランスグループホールディングス", "MS&AD,三井住友海上", "えむえすあんどえーでぃー", 0, "JP", "XTKS", "東証P", "JPY", "8725.T"],
  ["8795", "T&Dホールディングス", "大同生命,太陽生命,T&D", "てぃーあんどでぃー", 0, "JP", "XTKS", "東証P", "JPY", "8795.T"],
  ["8801", "三井不動産", "Mitsui Fudosan", "みついふどうさん", 0, "JP", "XTKS", "東証P", "JPY", "8801.T"],
  ["8802", "三菱地所", "Mitsubishi Estate", "みつびしじしょ", 0, "JP", "XTKS", "東証P", "JPY", "8802.T"],
  ["8830", "住友不動産", "Sumitomo Realty", "すみともふどうさん", 0, "JP", "XTKS", "東証P", "JPY", "8830.T"],
  ["9020", "東日本旅客鉄道", "JR東日本,JR East", "ひがしにほんりょかくてつどう じぇいあーるひがしにほん", 0, "JP", "XTKS", "東証P", "JPY", "9020.T"],
  ["9022", "東海旅客鉄道", "JR東海,JR Central", "とうかいりょかくてつどう じぇいあーるとうかい", 0, "JP", "XTKS", "東証P", "JPY", "9022.T"],
  ["9021", "西日本旅客鉄道", "JR西日本,JR West", "にしにほんりょかくてつどう じぇいあーるにしにほん", 0, "JP", "XTKS", "東証P", "JPY", "9021.T"],
  ["9202", "ANAホールディングス", "ANA,全日空", "えーえぬえーほーるでぃんぐす ぜんにっくう", 0, "JP", "XTKS", "東証P", "JPY", "9202.T"],
  ["9201", "日本航空", "JAL,日航", "にほんこうくう じゃる", 0, "JP", "XTKS", "東証P", "JPY", "9201.T"],
  ["9501", "東京電力ホールディングス", "東電,TEPCO", "とうきょうでんりょく", 0, "JP", "XTKS", "東証P", "JPY", "9501.T"],
  ["9502", "中部電力", "Chubu Electric", "ちゅうぶでんりょく", 0, "JP", "XTKS", "東証P", "JPY", "9502.T"],
  ["9503", "関西電力", "関電,KEPCO", "かんさいでんりょく", 0, "JP", "XTKS", "東証P", "JPY", "9503.T"],
  ["6861", "キーエンス", "Keyence", "きーえんす", 0, "JP", "XTKS", "東証P", "JPY", "6861.T"],
  ["4452", "花王", "Kao", "かおう", 0, "JP", "XTKS", "東証P", "JPY", "4452.T"],
  ["5108", "ブリヂストン", "Bridgestone", "ぶりぢすとん", 0, "JP", "XTKS", "東証P", "JPY", "5108.T"],
  ["6971", "京セラ", "Kyocera", "きょうせら", 0, "JP", "XTKS", "東証P", "JPY", "6971.T"],
  ["6762", "TDK", "ティーディーケイ", "てぃーでぃーけい", 0, "JP", "XTKS", "東証P", "JPY", "6762.T"],
  ["3092", "ZOZO", "ゾゾタウン", "ぞぞ ぞぞたうん", 0, "JP", "XTKS", "東証P", "JPY", "3092.T"],

  // --- Major Japanese ETFs & Indices ---
  ["1306", "NEXT FUNDS TOPIX連動型上場投信", "TOPIX ETF,NF TOPIX", "ねくすとふぁんず とぴっくす", 1, "JP", "XTKS", "東証ETF", "JPY", "1306.T"],
  ["1321", "NEXT FUNDS 日経225連動型上場投信", "日経225 ETF,NF 日経225", "ねくすとふぁんず にっけい225", 1, "JP", "XTKS", "東証ETF", "JPY", "1321.T"],
  ["1570", "NEXT FUNDS 日経平均レバレッジ・インデックス連動型上場投信", "日経レバ,NF 日経レバ", "にっけいればれっじ", 1, "JP", "XTKS", "東証ETF", "JPY", "1570.T"],
  ["1357", "NEXT FUNDS 日経ダブルインバース・インデックス連動型上場投信", "日経ダブルインバース,日経インバ", "にっけいだぶるいんばーす", 1, "JP", "XTKS", "東証ETF", "JPY", "1357.T"],
  ["1655", "iShares S&P 500 米国株 ETF", "iShares S&P500,S&P500 東証ETF", "あいしぇあーず えすあんどぴー500", 1, "JP", "XTKS", "東証ETF", "JPY", "1655.T"],
  ["2558", "MAXIS 米国株式(S&P500)上場投信", "MAXIS S&P500", "まきしす えすあんどぴー500", 1, "JP", "XTKS", "東証ETF", "JPY", "2558.T"],
  ["2559", "MAXIS 全世界株式(オール・カントリー)上場投信", "MAXIS オルカン", "まきしす おーるかんとりー おるかん", 1, "JP", "XTKS", "東証ETF", "JPY", "2559.T"],
  ["2631", "MAXIS ナスダック100上場投信", "MAXIS NASDAQ100", "まきしす なすだっく100", 1, "JP", "XTKS", "東証ETF", "JPY", "2631.T"],
  ["2244", "Global X US Tech Top 20 ETF", "GX USテック・トップ20", "ぐろーばるえっくす ゆーえすてっく", 1, "JP", "XTKS", "東証ETF", "JPY", "2244.T"],
  ["1540", "純金上場信託(現物国内保管型)", "金ETF,純金信託", "きんいーてぃーえふ じゅんきん", 1, "JP", "XTKS", "東証ETF", "JPY", "1540.T"],

  // --- Major US Stocks & Mega Caps ---
  ["AAPL", "Apple Inc.", "アップル,Apple", "あっぷる アップル", 0, "US", "XNAS", "NASDAQ", "USD", "AAPL"],
  ["NVDA", "NVIDIA Corporation", "エヌビディア,Nvidia", "えぬびでぃあ エヌビディア", 0, "US", "XNAS", "NASDAQ", "USD", "NVDA"],
  ["MSFT", "Microsoft Corporation", "マイクロソフト,Microsoft", "まいくろそふと マイクロソフト", 0, "US", "XNAS", "NASDAQ", "USD", "MSFT"],
  ["AMZN", "Amazon.com, Inc.", "アマゾン,Amazon", "あまぞん アマゾン", 0, "US", "XNAS", "NASDAQ", "USD", "AMZN"],
  ["GOOGL", "Alphabet Inc. (Class A)", "グーグル,Google,Alphabet", "ぐーぐる アルファベット", 0, "US", "XNAS", "NASDAQ", "USD", "GOOGL"],
  ["GOOG", "Alphabet Inc. (Class C)", "グーグル,Google", "ぐーぐる アルファベット", 0, "US", "XNAS", "NASDAQ", "USD", "GOOG"],
  ["META", "Meta Platforms, Inc.", "メタ,Facebook,フェイスブック", "めた ふぇいすぶっく", 0, "US", "XNAS", "NASDAQ", "USD", "META"],
  ["TSLA", "Tesla, Inc.", "テスラ,Tesla", "てすら テスラ", 0, "US", "XNAS", "NASDAQ", "USD", "TSLA"],
  ["AVGO", "Broadcom Inc.", "ブロードコム,Broadcom", "ぶろーどこむ", 0, "US", "XNAS", "NASDAQ", "USD", "AVGO"],
  ["BRK.B", "Berkshire Hathaway Inc. Class B", "バークシャー,バフェット", "ばーくしゃーはさうぇい", 0, "US", "XNYS", "NYSE", "USD", "BRK-B"],
  ["LLY", "Eli Lilly and Company", "イーライリリー,Eli Lilly", "いーらいりりー", 0, "US", "XNYS", "NYSE", "USD", "LLY"],
  ["JPM", "JPMorgan Chase & Co.", "JPモルガン,JPMorgan", "じぇいぴーもるがん", 0, "US", "XNYS", "NYSE", "USD", "JPM"],
  ["V", "Visa Inc.", "ビザ,VISA", "びざ ビザ", 0, "US", "XNYS", "NYSE", "USD", "V"],
  ["MA", "Mastercard Incorporated", "マスターカード,Mastercard", "ますたーかーど", 0, "US", "XNYS", "NYSE", "USD", "MA"],
  ["UNH", "UnitedHealth Group Incorporated", "ユナイテッドヘルス", "ゆないてっどへるす", 0, "US", "XNYS", "NYSE", "USD", "UNH"],
  ["XOM", "Exxon Mobil Corporation", "エクソンモービル,Exxon", "えくそんもーびる", 0, "US", "XNYS", "NYSE", "USD", "XOM"],
  ["JNJ", "Johnson & Johnson", "ジョンソン・エンド・ジョンソン,J&J", "じょんそんえんどじょんそん", 0, "US", "XNYS", "NYSE", "USD", "JNJ"],
  ["PG", "Procter & Gamble Company", "P&G,プロクター・アンド・ギャンブル", "ぴーあんどじー", 0, "US", "XNYS", "NYSE", "USD", "PG"],
  ["COST", "Costco Wholesale Corporation", "コストコ,Costco", "こすとこ コストコ", 0, "US", "XNAS", "NASDAQ", "USD", "COST"],
  ["HD", "The Home Depot, Inc.", "ホームデポ,Home Depot", "ほーむでぽ", 0, "US", "XNYS", "NYSE", "USD", "HD"],
  ["ABBV", "AbbVie Inc.", "アッヴィ,AbbVie", "あっゔぃ", 0, "US", "XNYS", "NYSE", "USD", "ABBV"],
  ["WMT", "Walmart Inc.", "ウォルマート,Walmart", "うぉるまーと", 0, "US", "XNYS", "NYSE", "USD", "WMT"],
  ["NFLX", "Netflix, Inc.", "ネットフリックス,Netflix", "ねっとふりっくす", 0, "US", "XNAS", "NASDAQ", "USD", "NFLX"],
  ["AMD", "Advanced Micro Devices, Inc.", "AMD", "えーえむでぃー", 0, "US", "XNAS", "NASDAQ", "USD", "AMD"],
  ["CRM", "Salesforce, Inc.", "セールスフォース,Salesforce", "せーるすふぉーす", 0, "US", "XNYS", "NYSE", "USD", "CRM"],
  ["ORCL", "Oracle Corporation", "オラクル,Oracle", "おらくる オラクル", 0, "US", "XNYS", "NYSE", "USD", "ORCL"],
  ["BAC", "Bank of America Corporation", "バンク・オブ・アメリカ,BofA", "ばんくおぶあめりか", 0, "US", "XNYS", "NYSE", "USD", "BAC"],
  ["CVX", "Chevron Corporation", "シェブロン,Chevron", "しぇぶろん", 0, "US", "XNYS", "NYSE", "USD", "CVX"],
  ["QCOM", "Qualcomm Incorporated", "クアルコム,Qualcomm", "くあるこむ", 0, "US", "XNAS", "NASDAQ", "USD", "QCOM"],
  ["PEP", "PepsiCo, Inc.", "ペプシコ,Pepsi", "ぺぷしこ", 0, "US", "XNAS", "NASDAQ", "USD", "PEP"],
  ["KO", "The Coca-Cola Company", "コカ・コーラ,Coca-Cola", "こかこーら コカコーラ", 0, "US", "XNYS", "NYSE", "USD", "KO"],
  ["MRK", "Merck & Co., Inc.", "メルク,Merck", "めるく", 0, "US", "XNYS", "NYSE", "USD", "MRK"],
  ["TMO", "Thermo Fisher Scientific Inc.", "サーモフィッシャー", "さーもふぃっしゃー", 0, "US", "XNYS", "NYSE", "USD", "TMO"],
  ["ADBE", "Adobe Inc.", "アドビ,Adobe", "あどび アドビ", 0, "US", "XNAS", "NASDAQ", "USD", "ADBE"],
  ["CSCO", "Cisco Systems, Inc.", "シスコ,Cisco", "しすこ", 0, "US", "XNAS", "NASDAQ", "USD", "CSCO"],
  ["INTC", "Intel Corporation", "インテル,Intel", "いんてる インテル", 0, "US", "XNAS", "NASDAQ", "USD", "INTC"],
  ["TXN", "Texas Instruments Incorporated", "テキサス・インスツルメンツ,TI", "てきさすいんすつるめんつ", 0, "US", "XNAS", "NASDAQ", "USD", "TXN"],
  ["AMAT", "Applied Materials, Inc.", "アプライド・マテリアルズ", "あぷらいどまてりあるず", 0, "US", "XNAS", "NASDAQ", "USD", "AMAT"],
  ["NOW", "ServiceNow, Inc.", "サービスナウ,ServiceNow", "さーびすなう", 0, "US", "XNYS", "NYSE", "USD", "NOW"],
  ["IBM", "International Business Machines", "IBM", "あいびーえむ", 0, "US", "XNYS", "NYSE", "USD", "IBM"],
  ["DIS", "The Walt Disney Company", "ディズニー,Disney", "でぃずにー ディズニー", 0, "US", "XNYS", "NYSE", "USD", "DIS"],
  ["MCD", "McDonald's Corporation", "マクドナルド,McDonald's", "まくどなるど マック", 0, "US", "XNYS", "NYSE", "USD", "MCD"],
  ["CAT", "Caterpillar Inc.", "キャタピラー,Caterpillar", "きゃたぴらー", 0, "US", "XNYS", "NYSE", "USD", "CAT"],
  ["GE", "GE Aerospace", "ゼネラル・エレクトリック,GE", "ぜねらるえれくとりっく", 0, "US", "XNYS", "NYSE", "USD", "GE"],
  ["UBER", "Uber Technologies, Inc.", "ウーバー,Uber", "うーばー ウーバー", 0, "US", "XNYS", "NYSE", "USD", "UBER"],
  ["PLTR", "Palantir Technologies Inc.", "パランティア,Palantir", "ぱらんてぃあ", 0, "US", "XNAS", "NASDAQ", "USD", "PLTR"],
  ["ARM", "Arm Holdings plc", "アーム,ARM", "あーむ", 0, "US", "XNAS", "NASDAQ", "USD", "ARM"],
  ["SMCI", "Super Micro Computer, Inc.", "スーパーマイクロ,SMCI", "すーぱーまいくろ", 0, "US", "XNAS", "NASDAQ", "USD", "SMCI"],

  // --- Major US ETFs ---
  ["SPY", "SPDR S&P 500 ETF Trust", "SPDR S&P500 ETF,S&P500", "すぱいだー えすあんどぴー500", 1, "US", "ARCX", "NYSE Arca", "USD", "SPY"],
  ["QQQ", "Invesco QQQ Trust Series 1", "QQQ,ナスダック100 ETF,Invesco QQQ", "きゅーきゅーきゅー なすだっく100", 1, "US", "XNAS", "NASDAQ", "USD", "QQQ"],
  ["VOO", "Vanguard S&P 500 ETF", "バンガード S&P500,VOO", "ばんがーど えすあんどぴー500", 1, "US", "ARCX", "NYSE Arca", "USD", "VOO"],
  ["VTI", "Vanguard Total Stock Market ETF", "バンガード VTI,全米株式 ETF", "ばんがーど ぶいてぃーあい ぜんべい", 1, "US", "ARCX", "NYSE Arca", "USD", "VTI"],
  ["IVV", "iShares Core S&P 500 ETF", "iShares S&P500,IVV", "あいしぇあーず えすあんどぴー500", 1, "US", "ARCX", "NYSE Arca", "USD", "IVV"],
  ["VT", "Vanguard Total World Stock ETF", "全世界株式 ETF,VT,バンガード VT", "ぜんせかいかぶしき ぶいてぃー", 1, "US", "ARCX", "NYSE Arca", "USD", "VT"],
  ["VEA", "Vanguard FTSE Developed Markets ETF", "VEA,先進国株式 ETF", "ぶいいーえー せんしんこく", 1, "US", "ARCX", "NYSE Arca", "USD", "VEA"],
  ["VWO", "Vanguard FTSE Emerging Markets ETF", "VWO,新興国株式 ETF", "ぶいだぶりゅーおー しんこうこく", 1, "US", "ARCX", "NYSE Arca", "USD", "VWO"],
  ["SMH", "VanEck Semiconductor ETF", "半導体 ETF,SMH", "はんどうたい えすえむえいち", 1, "US", "XNAS", "NASDAQ", "USD", "SMH"],
  ["SOXX", "iShares Semiconductor ETF", "半導体 ETF,SOXX", "はんどうたい そっくす", 1, "US", "XNAS", "NASDAQ", "USD", "SOXX"],
  ["SOXL", "Direxion Daily Semiconductor Bull 3X Shares", "半導体3倍ブル,SOXL", "そっくる はんどうたい3ばい", 1, "US", "ARCX", "NYSE Arca", "USD", "SOXL"],
  ["GLD", "SPDR Gold Shares", "金 ETF,GLD,ゴールド", "ごーるど きんいーてぃーえふ", 1, "US", "ARCX", "NYSE Arca", "USD", "GLD"],
  ["DIA", "SPDR Dow Jones Industrial Average ETF Trust", "NYダウ ETF,DIA", "だう いーてぃーえふ", 1, "US", "ARCX", "NYSE Arca", "USD", "DIA"],
  ["IWM", "iShares Russell 2000 ETF", "ラッセル2000 ETF,IWM", "らっせる2000", 1, "US", "ARCX", "NYSE Arca", "USD", "IWM"],
  ["TLT", "iShares 20+ Year Treasury Bond ETF", "米国債20年超 ETF,TLT", "べいこくさい20ねん", 1, "US", "XNAS", "NASDAQ", "USD", "TLT"],
  ["BND", "Vanguard Total Bond Market ETF", "総合債券 ETF,BND", "そうごうさいけん びーえぬでぃー", 1, "US", "XNAS", "NASDAQ", "USD", "BND"],
  ["VYM", "Vanguard High Dividend Yield ETF", "バンガード 米国高配当株式 ETF,VYM", "こうはいとう ぶいわいえむ", 1, "US", "ARCX", "NYSE Arca", "USD", "VYM"],
  ["HDV", "iShares Core High Dividend ETF", "iShares 高配当株 ETF,HDV", "こうはいとう えいちでぃーぶい", 1, "US", "ARCX", "NYSE Arca", "USD", "HDV"],
  ["SPYD", "SPDR Portfolio S&P 500 High Dividend ETF", "SPYD,S&P500高配当 ETF", "えすぴーわいでぃー こうはいとう", 1, "US", "ARCX", "NYSE Arca", "USD", "SPYD"],
  ["JEPI", "JPMorgan Equity Premium Income ETF", "JEPI,JPモルガン カバードコール ETF", "じぇぴ じぇいえぴーあい", 1, "US", "ARCX", "NYSE Arca", "USD", "JEPI"],

  // --- Popular Mutual Funds ---
  ["0331418A", "eMAXIS Slim 全世界株式（オール・カントリー）", "eMAXIS Slim オルカン,オルカン,オールカントリー,全世界株式", "おるかん おーるかんとりー ぜんせかいかぶしき", 2, "JP", "JPFD", "投資信託", "JPY", "0331418A"],
  ["03311187", "eMAXIS Slim 米国株式（S&P500）", "eMAXIS Slim S&P500,Slim S&P500,S&P500 投信", "えすあんどぴー500 べいこくかぶしき", 2, "JP", "JPFD", "投資信託", "JPY", "03311187"],
  ["03312172", "eMAXIS Slim 先進国株式インデックス", "eMAXIS Slim 先進国株式", "せんしんこくかぶしき", 2, "JP", "JPFD", "投資信託", "JPY", "03312172"],
  ["03313172", "eMAXIS Slim 国内株式（TOPIX）", "eMAXIS Slim TOPIX", "とぴっくす こくないかぶしき", 2, "JP", "JPFD", "投資信託", "JPY", "03313172"],
  ["03311172", "eMAXIS Slim 国内株式（日経平均）", "eMAXIS Slim 日経平均", "にっけいへいきん こくないかぶしき", 2, "JP", "JPFD", "投資信託", "JPY", "03311172"],
  ["89311199", "SBI・V・S&P500インデックス・ファンド", "SBI・V・S&P500,SBI S&P500", "えすびーあい えすあんどぴー500", 2, "JP", "JPFD", "投資信託", "JPY", "89311199"],
  ["89312221", "SBI・V・全米株式インデックス・ファンド", "SBI・V・全米株式,SBI 全米株式", "えすびーあい ぜんべいかぶしき", 2, "JP", "JPFD", "投資信託", "JPY", "89312221"],
  ["89311221", "SBI・V・全世界株式インデックス・ファンド", "SBI・V・全世界株式,SBI 全世界株式", "えすびーあい ぜんせかいかぶしき", 2, "JP", "JPFD", "投資信託", "JPY", "89311221"],
  ["9I311179", "楽天・全米株式インデックス・ファンド", "楽天・全米株式,楽天VTI", "らくてん ぜんべいかぶしき ぶいてぃーあい", 2, "JP", "JPFD", "投資信託", "JPY", "9I311179"],
  ["9I312179", "楽天・全世界株式インデックス・ファンド", "楽天・全世界株式,楽天VT", "らくてん ぜんせかいかぶしき ぶいてぃー", 2, "JP", "JPFD", "投資信託", "JPY", "9I312179"],
  ["9I31323A", "楽天・S&P500インデックス・ファンド", "楽天・S&P500,楽天S&P500", "らくてん えすあんどぴー500", 2, "JP", "JPFD", "投資信託", "JPY", "9I31323A"],
  ["9I31423A", "楽天・オールカントリー株式インデックス・ファンド", "楽天・オールカントリー,楽天オルカン", "らくてん おーるかんとりー おるかん", 2, "JP", "JPFD", "投資信託", "JPY", "9I31423A"],
];

function expandCatalogEntry(tuple: CompactTuple): CatalogSecurity {
  const [
    symbol,
    name,
    aliasesStr,
    readingKana,
    assetTypeIdx,
    country,
    exchangeMic,
    exchangeLabel,
    currency,
    yahooProviderSymbol,
  ] = tuple;

  const assetType = ASSET_TYPES[assetTypeIdx];
  const aliases = aliasesStr ? aliasesStr.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const id = assetType === "fund"
    ? country === "JP"
      ? `sec-jp-fund-${symbol.toLowerCase()}`
      : `sec-foreign-fund-${symbol.toLowerCase()}`
    : country === "JP"
    ? `sec-${symbol.toLowerCase()}-xtks`
    : `sec-us-${symbol.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

  const providerSymbols: { yahoo?: string } = {};
  if (yahooProviderSymbol) {
    providerSymbols.yahoo = yahooProviderSymbol;
  } else if (country === "JP") {
    providerSymbols.yahoo = assetType === "fund" ? symbol : `${symbol}.T`;
  } else {
    providerSymbols.yahoo = symbol;
  }

  return {
    id,
    displaySymbol: symbol,
    name,
    assetType,
    country,
    exchangeMic,
    exchangeLabel,
    currency,
    providerSymbols,
    aliases,
    readingKana,
  };
}

let cachedSecurities: CatalogSecurity[] | null = null;
let cachedSearchIndex: SecuritySearchIndex<CatalogSecurity> | null = null;

export function getEmbeddedCatalogSecurities(): CatalogSecurity[] {
  if (!cachedSecurities) {
    cachedSecurities = RAW_STOCK_CATALOG.map(expandCatalogEntry);
  }
  return cachedSecurities;
}

function getEmbeddedCatalogSearchIndex(): SecuritySearchIndex<CatalogSecurity> {
  if (!cachedSearchIndex) {
    cachedSearchIndex = buildSecuritySearchIndex(getEmbeddedCatalogSecurities());
  }
  return cachedSearchIndex;
}

export function searchEmbeddedCatalog(query: string): CatalogSecurity[] {
  return searchSecurityIndex(getEmbeddedCatalogSearchIndex(), query, 15);
}
