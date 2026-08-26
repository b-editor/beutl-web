# beutl-web

The monorepo behind Beutl's marketplace, account and developer dashboards,
checkout flows, admin console, and desktop-facing APIs.

The Web and admin applications use Next.js App Router. Desktop APIs use Hono,
with Prisma and CockroachDB for persistence. Production workloads run on
Cloudflare Workers.

## Repository layout

| Path | Package | Purpose |
| --- | --- | --- |
| `apps/web` | `@beutl/web` | Public site, account and developer dashboards, authentication, and checkout |
| `apps/admin` | `@beutl/admin` | Administrative console |
| `packages/api` | `@beutl/api` | Hono APIs for desktop clients (`v1`, `v2`, and `v3`) |
| `packages/core` | `@beutl/core` | Framework-independent domain logic |
| `packages/db` | `@beutl/db` | Prisma client and data-access helpers |
| `packages/email` | `@beutl/email` | Server-only email delivery |
| `packages/i18n` | `@beutl/i18n` | Translations and locale resolution |
| `packages/next` | `@beutl/next` | Shared Next.js server helpers |
| `packages/ui` | `@beutl/ui` | Shared UI components |
| `tests/contract` | — | Golden and external-contract tests |
| `tests/integration` | — | Tests that use CockroachDB or live provider data when enabled |

## Getting started

Use the Node.js version in [`.nvmrc`](.nvmrc) and the pnpm version declared in
[`package.json`](package.json). Corepack can activate that pnpm version.

```bash
corepack enable
pnpm install
cp apps/web/.env.sample apps/web/.env.local
pnpm dev
```

Fill in the values needed for the flow you are developing. The public Web app
runs at `http://localhost:3000`.

To run the admin console at `http://localhost:3001`:

```bash
cp apps/admin/.env.sample apps/admin/.env.local
pnpm dev:admin
```

Local environment files and Wrangler `.dev.vars` files are ignored by Git and
must not be committed.

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the public Web app |
| `pnpm dev:admin` | Start the admin console |
| `pnpm build` | Build both Next.js apps and type-check the desktop API |
| `pnpm lint` | Lint both Next.js apps |
| `pnpm typecheck` | Type-check every workspace that defines a type-check script |
| `pnpm test` | Run the Vitest contract and integration suites |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm preview` | Build and preview the public Cloudflare Worker locally |

CockroachDB integration tests require `TEST_DATABASE_URL`. The live OpenRouter
pricing test is opt-in through `TEST_OPENROUTER_PRICING=1`; these tests are
skipped when their respective variables are absent.

## Deployment

Production is split across three Cloudflare Workers. The longest matching
Cloudflare route sends desktop API traffic to the dedicated API Worker.

| Worker | Routes | Command |
| --- | --- | --- |
| `beutl-web` | `beutl.beditor.net/*`, except the desktop API routes | `pnpm deploy:web` |
| `beutl-web-api` | `beutl.beditor.net/api/v{1,2,3}/*` | `pnpm deploy:api` |
| `beutl-admin` | `admin.beutl.beditor.net/*` | `pnpm deploy:admin` |

Before deploying, read [Deployment configuration](docs/deployment.md) for
cross-Worker secrets, admin session sharing, Paid AI settings, and required
Stripe webhook events. The route split and its rollback procedure are recorded
in [ADR 0002](docs/adr/0002-api-worker-split.md).

Deploy through `pnpm run release`, which fixes the order. Deploying a Worker before
its migrations have been applied breaks every path that reads a table the Worker
expects, so migrations go first.

Migrations are usually additive, which is what makes that order safe: the running
Worker keeps working while the new columns appear. **That is a habit, not a rule.**
`20260824060000_drop_legacy_rename_reservations` deletes rows, and a migration that
deletes has to be read against what the old Worker is still doing at the time — in
that case rename reservations recorded before the source name existed, which no
longer had a Worker able to settle them. Check each one rather than assuming.

```bash
BEUTL_SMOKE_JWT=<a user's JWT> pnpm run release
```

It runs `prisma migrate deploy`, refuses to go on unless `prisma migrate status`
reports everything applied, deploys the three Workers, and then checks
`GET /api/v3/git/account` and `GET /api/v3/git/credentials` with the supplied token --
both read tables the Workers cannot serve without the migrations. Without a token it
stops after the deploy and says so; pass `--skip-smoke` to accept that deliberately.
`--dry-run` prints the steps without running them.

`pnpm run deploy` runs the same thing. The individual steps exist for when you
deliberately want one of them, and running them alone skips the ordering:

```bash
pnpm run migrate:deploy # apply pending migrations
pnpm run migrate:status # report what is applied
pnpm run deploy:web     # Web Worker (OpenNext build + deploy)
pnpm run deploy:api     # API Worker (wrangler deploy)
pnpm run deploy:admin   # Admin Worker (OpenNext build + deploy)
```

The smoke test covers what an anonymous request and one user's JWT can reach: all
three Workers respond, and the API Worker serves a route backed by a table this
branch adds. It does not cover the Web and Admin Workers' Forgejo secrets (those
need a session), the admin deletion path, or the scheduled cron -- the script
prints that list every run rather than leaving it implied. `/api/v3/git/account`
provisions a Forgejo user when one is missing, so it is only called when
`BEUTL_SMOKE_PROVISION=1` says the token belongs to a dedicated smoke account.

The pre-check also catches a database carrying migrations this checkout does not
have -- either the checkout is behind, or the database has an unmerged branch's
migrations applied to it. The shared development cluster is in the second state,
so `pnpm run migrate:status` reports a divergence there even when the checkout is
current with `main`. Once migrations are applied out of order, that divergence is
permanent, which is why the check runs before anything writes.

Cloudflare bindings are declared in `apps/web/wrangler.jsonc`, `packages/api/wrangler.jsonc`
and `apps/admin/wrangler.jsonc`; local environment placeholders are documented in
`apps/web/.env.sample` and `apps/admin/.env.sample`.
`JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` must match between the Web and API Workers
(CI deploys from GitHub Secrets).

## Documentation

- [Deployment configuration](docs/deployment.md)
- [ADR 0001: v1 account is the authentication backbone](docs/adr/0001-v1-account-is-the-auth-backbone.md)
- [ADR 0002: desktop API Worker split](docs/adr/0002-api-worker-split.md)
- [Stripe AI billing migration safety](docs/stripe-ai-billing-migration.md)
