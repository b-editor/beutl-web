# 0002: デスクトップ API の独立 Worker デプロイ (同一ドメイン・パス分割)

- 状態: Accepted
- 日付: 2026-08-06

## 背景

beutl-web は Next.js 15 モノリスとして単一 Cloudflare Worker (beutl-web) にデプロイされていた。
デスクトップアプリ (Beutl) が消費する Hono API (v1/v2/v3) と Web UI が同じデプロイ単位にあり、
API の変更が Web 全体のデプロイに影響していた。

## 決定

デスクトップ API (v1/v2/v3) を **同一ドメイン・パス分割**で独立 Worker (`beutl-web-api`) としてデプロイする。

- `beutl.beditor.net/api/v1/*`, `/api/v2/*`, `/api/v3/*` → `beutl-web-api`
- それ以外 (`/api/auth`, `/api/contents`, `/api/stripe`, Web ページ) → `beutl-web`
- Workers Routes の最長一致により、api パターンが優先される

## 理由

- **native-auth フロー維持**: v1 `createAuthUri` が返す `auth_uri` は Web の page handler (`/account/native-auth/handler`) を指す。
  better-auth の Cookie セッションを共有するため、**同一ドメインであることが必須**。
- **外部契約の不変性**: v1/account は唯一の JWT 発行面 (v1-is-auth-backbone, ADR 0001)。
  デスクトップアプリとのバイト等価性 (v3 JSON, JWT claim, refresh 暗号化) を維持する。
- **独立デプロイ**: API のデプロイが Web に影響しない。Web の変更も API に影響しない。

## 構成

```
apps/web/            # Next.js Web アプリ (@beutl/web) → beutl-web Worker
packages/api/        # Hono API パッケージ (@beutl/api) → beutl-web-api Worker
  src/worker.ts      # fetch エントリ (setDbProvider + api.fetch)
  wrangler.jsonc     # routes: beutl.beditor.net/api/v{1,2,3}/*
packages/db/         # データアクセス層 (setDbProvider/getDb)
packages/i18n/       # i18n (静的 resource map)
packages/core/       # 純粋ロジック
```

## 環境変数の共有 (MUST MATCH)

デスクトップ API の JWT 検証は Web 側 (v1) で発行したトークンを使うため、
`JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` は両 Worker で**同一値**であること。
CI (deploy.yml) は GitHub Secrets を単一ソースとし、両 Worker へ同一値を投入する。

## ロールバック手順

1. Cloudflare Dashboard で `beutl.beditor.net/api/v{1,2,3}/*` の routes を削除
2. Web Worker (beutl-web) が従来どおり v1/v2/v3 を処理する
   (apps/web/src/app/api/v{1,2,3} の route.ts は `@beutl/api` 参照のまま温存)

## 関連

- ADR 0001: v1/account は認証の背骨 (削除不可)
- REFACTORING_PLAN.md: 内部リファクタ計画 (独立した計画)
