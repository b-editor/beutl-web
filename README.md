# beutl-web

Beutl's marketplace web application for browsing packages, managing developer projects, user accounts, releases, checkout, and public API endpoints.

## Monorepo structure

```
apps/web/            # Next.js Web アプリ (@beutl/web) → beutl-web Worker
packages/api/        # デスクトップ API (v1/v2/v3, Hono) → beutl-web-api Worker
packages/db/         # データアクセス層 (@beutl/db)
packages/i18n/       # i18n (静的 resource map) (@beutl/i18n)
packages/core/       # 純粋ロジック (@beutl/core)
tests/contract/      # 外部契約のゴールデンテスト (Vitest)
```

## Technology

- Next.js App Router
- Prisma with PostgreSQL-compatible database access (CockroachDB)
- Better Auth for authentication
- Stripe checkout and webhooks
- Cloudflare Workers deployment (OpenNext Cloudflare for Web, wrangler for API)
- pnpm workspaces

## Development

Use the Node major declared in `.nvmrc`, then install dependencies and start the local server:

```bash
pnpm install
pnpm dev
```

Run linting with:

```bash
pnpm lint
```

Run contract tests (external API golden tests):

```bash
pnpm test
```

## Deployment

Two Workers are deployed with same-domain path routing (see `docs/adr/0002-api-worker-split.md`):

- `beutl-web` (Web): `beutl.beditor.net/*` (except API paths)
- `beutl-web-api` (desktop API): `beutl.beditor.net/api/v{1,2,3}/*`

```bash
pnpm run deploy:web   # Web Worker (OpenNext build + deploy)
pnpm run deploy:api   # API Worker (wrangler deploy)
```

Cloudflare bindings are declared in `apps/web/wrangler.jsonc` and `packages/api/wrangler.jsonc`;
local environment placeholders are documented in `apps/web/.env.sample`.
`JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` must match between both Workers (CI deploys from GitHub Secrets).
