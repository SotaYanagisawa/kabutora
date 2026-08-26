# 株トラ cloud deployment

## 構成

1. FirebaseでGoogle Authentication、Cloud Firestore、reCAPTCHA Enterprise App Checkを有効化し、動作確認後にAuthenticationとFirestoreのApp Checkを明示的に強制する。
2. `firebase/firestore.rules` と `firebase/firestore.indexes.json` をデプロイする。
3. 最初のGoogleサインイン後にAuthenticationのUIDを確認し、Firestoreコンソールから`appAccess/{UID}`の空ドキュメントを1件だけ管理者として作成する。
4. Cloudflare Workersへ`apps/web/.open-next`をデプロイする。
5. Firebaseの許可ドメインへWorkerのホスト名を追加する。
6. Cloudflare SecretsへFirebase project ID、project number、web app ID、許可UIDを設定する。Wranglerは4項目が欠けたデプロイを拒否する。
7. 認証・App Checkが有効な状態で市場APIが401/200を正しく返すことを確認する。

公開用ビルドでは `KABUTORA_LOCAL_VAULT_PATH` と `KABUTORA_LOCAL_VAULT_KEY` を設定しない。`KABUTORA_REQUIRE_AUTH` と `KABUTORA_REQUIRE_APP_CHECK` は常に`true`にする。Cloudflare invocation URLログは無効のままにする。

## 初回移行

1. Mac版の設定から暗号化バックアップを作成する。
2. 復旧キーファイルをパスワード管理アプリまたは紙へ移し、暗号化JSONとは分離する。
3. iPhoneでクラウド版を開き、「個人端末」を選ぶ。
4. 許可済みGoogleアカウントでサインインし、暗号化JSONを読み込む。
5. パスフレーズまたは復旧キーでバックアップを復元し、件数と評価を確認する。復元後はGoogleアカウント用の解除鍵がUID限定で登録される。
6. Safariの共有メニューから「ホーム画面に追加」を選ぶ。

パスフレーズと復旧キーは暗号化JSONの復元時だけ使用する。クラウドへ同期済みなら、新しい端末は許可済みGoogleアカウントへのログインだけで解除できる。「ロック」は現在の画面だけを閉じ、「ログアウト」はGoogleセッションと端末用高速化鍵を削除する。共有端末モードには端末用鍵を保存しない。
