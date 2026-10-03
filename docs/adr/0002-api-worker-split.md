# 0002: Web と公開 API を同じ Worker に含める

- 状態: Accepted (2026-08-06 の API Worker 分離を撤回)
- 更新日: 2026-10-04

## 背景

API を別 Worker の入口だけに接続すると、Web のデプロイが成功しても追加した
API が公開されない。Hosted Git のリポジトリ作成で、この状態による 404 が発生した。

## 決定

Web とすべての公開 API は **単一の `beutl-web` Worker** に含める。
`packages/api` はコード共有の単位であり、独立したデプロイ単位にはしない。

- `apps/web/worker.js` が `/api/v1`, `/api/v2`, `/api/v3` を共通 API runtime に渡す。
- Git/LFS とストレージの本文は OpenNext のバッファリングより前に処理する。
- その他の Web ページ、認証、コンテンツ、Stripe API は OpenNext が処理する。
- 公開 API の bindings、Durable Objects、cron は `apps/web/wrangler.jsonc` に置く。
- API runtime は呼び出しごとの DB/ストレージ provider を使い、並行する Web 処理の
  provider を置き換えない。背景処理が終わってから DB 接続を閉じる。
- Admin と非公開の画像処理 service Worker はそれぞれの用途のまま維持する。

## 再発防止

新しい公開 API は Web の入口を通して契約テストを行う。
`tests/contract/web-api-entrypoint.test.ts` はリポジトリ作成、Git 転送、サイズ制限、
Web へのフォールバック、cron 接続と実際のデプロイ設定を確認する。
独立 API Worker の Wrangler 設定や deploy/upload コマンドを再導入しない。

以前の分離構成を使用していた環境では、旧 `/api/v{1,2,3}/*` の Worker routes を
取り除き、Web のカスタムドメインに全公開リクエストを届ける。
JWT の発行・検証は同じ Web secrets を使う。クライアントの URL は変更しない。

## 関連

- ADR 0001: v1/account は認証の背骨 (削除不可)
- [Deployment configuration](../deployment.md)
