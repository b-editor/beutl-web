# beutl-web

Beutl's marketplace web application for browsing packages, managing developer projects, user accounts, releases, checkout, and public API endpoints.

## Monorepo structure

```
apps/web/            # Next.js Web アプリ (@beutl/web) → beutl-web Worker
apps/admin/          # 管理画面 Next.js アプリ (@beutl/admin) → beutl-admin Worker
packages/api/        # デスクトップ API (v1/v2/v3, Hono) → beutl-web-api Worker
packages/db/         # データアクセス層 (@beutl/db)
packages/i18n/       # i18n (静的 resource map) (@beutl/i18n)
packages/core/       # 純粋ロジック (@beutl/core)
packages/ui/         # 共有 UI コンポーネント (shadcn/ui, @beutl/ui)
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

Three Workers are deployed (see `docs/adr/0002-api-worker-split.md` for the path split):

- `beutl-web` (Web): `beutl.beditor.net/*` (except API paths)
- `beutl-web-api` (desktop API): `beutl.beditor.net/api/v{1,2,3}/*`
- `beutl-admin` (admin console): `admin.beutl.beditor.net/*`

```bash
pnpm run deploy:web   # Web Worker (OpenNext build + deploy)
pnpm run deploy:api   # API Worker (wrangler deploy)
pnpm run deploy:admin # Admin Worker (OpenNext build + deploy)
```

Cloudflare bindings are declared in `apps/web/wrangler.jsonc` and `packages/api/wrangler.jsonc`;
local environment placeholders are documented in `apps/web/.env.sample`.
`JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` must match between both Workers (CI deploys from GitHub Secrets).

The admin console shares the better-auth session with the Web app via
`crossSubDomainCookies`. Set `BETTER_AUTH_COOKIE_DOMAIN` to the narrowest domain
that covers both Workers (`beutl.beditor.net` in production); `admin.beutl.beditor.net`
is a subdomain of it. Do not use the root domain `beditor.net`, which would send the
session cookie to every unrelated host under it. The admin Worker needs the same
`BETTER_AUTH_SECRET` and OAuth client IDs (Google/GitHub) as the Web app; OAuth
redirect URIs for `admin.beutl.beditor.net` must be registered on the provider side.
Access is restricted to the user IDs in `ADMIN_USER_IDS`.

Note: adding a `Domain` attribute to previously host-only cookies creates a separate
cookie entry in the browser. Both may be sent together during rollout, so existing
session cookies should be explicitly expired when enabling this.
