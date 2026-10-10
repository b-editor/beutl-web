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
| `apps/image-worker` | `@beutl/image-worker` | Private Cloudflare Worker for AI image editing |
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

The workspace root's `postinstall` generates the shared Prisma Client once after
dependency installation. Keep this hook at the root: per-app hooks run in parallel
and would write to the same generated client. The generator uses a temporary schema
and leaves `apps/web/prisma/schema.prisma` unchanged.

## Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the public Web app |
| `pnpm dev:admin` | Start the admin console |
| `pnpm build` | Build both Next.js apps and the image Worker, and type-check the shared API |
| `pnpm lint` | Lint both Next.js apps |
| `pnpm typecheck` | Type-check every workspace that defines a type-check script |
| `pnpm test` | Run the Vitest contract and integration suites |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm preview` | Build and preview the public Cloudflare Worker locally |

CockroachDB integration tests require `TEST_DATABASE_URL`. The live OpenRouter
pricing test is opt-in through `TEST_OPENROUTER_PRICING=1`; these tests are
skipped when their respective variables are absent.

## Landing-page recording

The editor demonstration is maintained in [beutl-demos](https://github.com/b-editor/beutl-demos).
After reviewing and recording a new capture there, run its `scripts/demo.py web-assets`
command with this checkout as `--web`. Commit `apps/web/public/img/showcase.mp4`,
`showcase.webm`, and `showcase-poster.png` together. Both videos are 1920×1080 at
30 fps, and the poster is the first frame. Keep the showcase dimensions and the
English/Japanese description in sync with the recording.

## Continuous integration and deployment

[GitHub Actions](.github/workflows/ci.yml) runs the Vitest suite on pull requests
and pushes to `main`. After tests and builds pass on `main`, it applies pending
Prisma migrations to the production database, then deploys `beutl-ai-images`,
`beutl-web` (including public APIs), and `beutl-admin` in that order using the
existing deployment tooling. Web and Admin are built without Cloudflare
credentials. Immediately before each Worker deployment, the run's commit must
still match the head of `main`. A manual run on `main` also tests and deploys.
DB and live-provider tests remain opt-in and are skipped in this workflow.

Set these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`: a token authorized to deploy Workers and access the
  configured R2, Hyperdrive, and Durable Object resources in the target account.
- `CLOUDFLARE_ACCOUNT_ID`: the target Cloudflare account ID.
- `DATABASE_URL`: a direct connection string to the production CockroachDB
  database with permission to apply Prisma migrations. A missing secret or
  failed migration stops the workflow before any Worker is deployed.
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`: a fixed base64 AES key for the Web and
  Admin builds, created once with `openssl rand -base64 32`. Next derives
  Server Action IDs from it and from each file's path in the CI checkout, so
  an unchanged action keeps its ID across deployments and a page opened before
  a deploy can still call it. Changing the key invalidates every open page's
  actions once.

Keep application secrets and runtime variables configured in Cloudflare as
described in [Deployment configuration](docs/deployment.md). Apply pending
database migrations before deploying Workers manually as well.

## Deployment

The public Web app and all desktop APIs deploy together as `beutl-web`.
`packages/api` is shared application code, not a separate API Worker. The Web
entrypoint dispatches `/api/v{1,2,3}/*` before OpenNext so uploads remain streamed.

| Worker | Routes | Command |
| --- | --- | --- |
| `beutl-web` | `beutl.beditor.net/*`, including all public APIs | `vp run deploy:web` |
| `beutl-admin` | `admin.beutl.beditor.net/*` | `vp run deploy:admin` |
| `beutl-ai-images` | Service binding only; no public route | `vp run deploy:image-worker` |

The `vp` commands require the [Vite+ CLI](https://viteplus.dev/guide/).
The workspace also supports the pnpm runner configured in `package.json`: use
`pnpm run deploy:web` or `pnpm run deploy:admin` when Vite+ is not installed.

Deploy `beutl-ai-images` and configure its secrets before deploying a Web
version that binds to it.

Before deploying, read [Deployment configuration](docs/deployment.md) for
cross-Worker secrets, admin session sharing, Paid AI settings, and required
Stripe webhook events. The single public deployment requirement is recorded
in [ADR 0002](docs/adr/0002-api-worker-split.md).

## Documentation

- [Deployment configuration](docs/deployment.md)
- [ADR 0001: v1 account is the authentication backbone](docs/adr/0001-v1-account-is-the-auth-backbone.md)
- [ADR 0002: public Web/API deployment](docs/adr/0002-api-worker-split.md)
- [Stripe AI billing migration safety](docs/stripe-ai-billing-migration.md)
