# 株トラ

日本株と米国株を追跡する、個人向けポートフォリオPWAです。Excelから採用したのは初期の売買・入出金履歴だけです。価格取得、損益計算、履歴再構築はExcelから完全に独立しています。

## 起動

通常のMacアプリは `/Applications/株トラ.app` にインストールされています。FinderまたはSpotlightから「株トラ」を開けます。`pnpm` やターミナルは不要です。

開発モードで起動する場合：

```bash
pnpm install
pnpm dev
```

ブラウザで `http://localhost:3000` を開きます。

## 確認

```bash
pnpm test
pnpm typecheck
pnpm build
```

Mac版は端末内モードで動作します。取引台帳はアプリ本体やソースツリーへ格納せず、`~/Library/Application Support/株トラ/local-vault.json` にAES-256-GCM暗号化して保存し、鍵はmacOSログインキーチェーンで管理します。クラウド版はFirebase Authentication、App Check、暗号文だけを保存するFirestore、Cloudflare Workersを使います。概要画面では保有中銘柄の5営業日・15分足を取得し、長期の日次履歴は必要な期間だけ差分更新します。Cloudflareのエッジキャッシュと端末のIndexedDBキャッシュで外部APIへの要求数を抑えます。

クラウドへ移行するときは、Mac版の「設定 → 暗号化バックアップ」でJSONと復旧キーを作成し、スマホ側でJSONを読み込みます。個人端末では最初の1回だけパスフレーズを入力すると、非抽出可能な端末登録鍵がブラウザ内に保存され、以後はGoogleのログイン状態から自動解除されます。パスフレーズと復旧キーはFirebase・Cloudflareへ送信されません。

公開ビルドまたはMacアプリに実データが混入していないことは、`pnpm verify:privacy -- <対象ディレクトリ>` でローカル暗号化台帳と照合できます。検査時に取引内容や暗号鍵を出力しません。
