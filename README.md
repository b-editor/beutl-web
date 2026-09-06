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

Cloudflare bindings are declared in `apps/web/wrangler.jsonc`, `packages/api/wrangler.jsonc`
and `apps/admin/wrangler.jsonc`; local environment placeholders are documented in
`apps/web/.env.sample` and `apps/admin/.env.sample`.
`JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` must match between the Web and API Workers
(CI deploys from GitHub Secrets).

The admin console can share the better-auth session with the Web app via
`crossSubDomainCookies`, which is enabled only when `BETTER_AUTH_COOKIE_DOMAIN` is set.
Set it to the narrowest domain that covers both Workers (`beutl.beditor.net` in
production); `admin.beutl.beditor.net` is a subdomain of it. Do not use the root domain
`beditor.net`, which would send the session cookie to every unrelated host under it.
Leaving it unset (the default, including local development) keeps each Worker on a
host-only session cookie and disables session sharing. The admin Worker needs the same
`BETTER_AUTH_SECRET` and OAuth client IDs (Google/GitHub) as the Web app; OAuth
redirect URIs for `admin.beutl.beditor.net` must be registered on the provider side.
Access is restricted to the user IDs in `ADMIN_USER_IDS`.

Note: adding a `Domain` attribute to previously host-only cookies creates a separate
cookie entry in the browser. Both may be sent together during rollout, so existing
session cookies should be explicitly expired when enabling this.

### Paid AI configuration

The Web Worker requires `STRIPE_PRO_PRICE_ID` for the monthly Pro subscription,
`STRIPE_CREDIT_PRICE_ID` for the one-time 500-unit top-up, and an explicit
`STRIPE_BILLING_PORTAL_CONFIGURATION_ID` whose configuration disables
subscription price switching and cancels at period end. Rotated Pro offers must
be listed as immutable `priceId:productId` pairs in
`STRIPE_PRO_HISTORICAL_OFFERS`; they are never learned from a customer-edited
subscription. The API Worker
requires `OPENROUTER_WEBHOOK_SECRET` as a Cloudflare secret so ambiguous video
submissions can be reconciled through signed provider callbacks. It also
requires `OPENROUTER_API_KEY` as a Wrangler secret. Provider calls default to a
120-second deadline, configurable with `OPENROUTER_REQUEST_TIMEOUT_MS`.

The API Worker also requires `STRIPE_SECRET_KEY`. Its scheduled run reconciles
the refunds owed for top-ups and for Pro billing, and both reconcilers need a
Stripe client; without the secret the cron fails and compensating refunds stop
being issued. It is the same secret the Web Worker uses.

An operation can offer several models, each with its own usage-unit price, and
the caller picks one per request — `model` on the v3 request bodies, a field on
the dashboard forms. Omitting it runs the operation's default. An unknown or
disabled model is refused rather than replaced by the default, since that would
charge the default's price for a model nobody asked for. The models on offer are
registered per operation from the admin console (`/admin/ai`) and stored in the
`AiOperationModel` table; an operation with none registered runs on the single
model and price the console holds in `AiSetting`, which is also where the
monthly allowance granted to each Pro subscription lives. Each value resolves
from the database or the built-in default (500 units per period for the
allowance). Every change is written to the audit log in the same transaction.

Clients learn the models from `GET /api/v3/ai/capabilities`, which names them
and orders them by relative expense (`costTier`: `low` / `medium` / `high`)
without stating any price; `GET /api/v3/user/entitlements` says which of them
the account can currently afford in `modelAvailability`. Prices themselves never
leave the server.
API keys and other secrets are deliberately **not** configurable this way and
stay in Wrangler secrets. A price change applies only to operations started
afterwards: each job records the price reserved at its start and is refunded at
that same price. An allowance change likewise applies to operations started
afterwards; usage already consumed in the current period is left untouched.

The settings page shows what each price and the allowance actually amount to,
so they are not set blind: how far the allowance goes for each operation, what
one usage unit is worth in money (per allowance unit and per purchased unit),
and an estimated provider cost with its resulting cost ratio.

Prices are read from Stripe directly, so the page is accurate before the first
sale — `BillingOffer` only holds terms a checkout has already been created
against. The admin Worker needs `STRIPE_SECRET_KEY`, `STRIPE_PRO_PRICE_ID`, and
`STRIPE_CREDIT_PRICE_ID` for this; **use a Stripe restricted key limited to
`prices: read`**, since the admin console has no reason to be able to move
money. Without them the page falls back to the recorded offer and says so, and
when Stripe and the stored offer disagree it flags that too (purchases still
settle against the stored terms).

Pro and credit top-up Checkout Sessions let customers enter active Stripe
promotion codes. Create and constrain those codes in the Stripe Dashboard; the
package store does not accept them. A top-up promotion must leave a positive
amount to pay because credit fulfillment is tied to its successful
PaymentIntent, so do not make a 100%-off code eligible for the top-up Price.

Costs come from OpenRouter's public price endpoints, which need no API key, so
the admin Worker holds no provider credentials. They
are estimates from a published rate card, not recorded spend: where a rate is
quoted per token rather than per image or per second, the assumption used to
bridge it is stated on screen, and anything whose unit cannot be determined is
reported as unknown rather than shown as free.

`/admin/ai/usage` reports jobs and usage units over a selected window, the
balances every account currently holds, the heaviest consumers, and how much of
the allowance subscribers actually consume (median, 90th percentile, and the
share who exhaust it). That distribution reads the current billing period only,
and rows whose period has already ended are excluded, because the usage counter
is not cleared until the account next runs a job. Individual
balances are corrected from the user detail page (`/admin/users/<id>`): an
administrator can grant or revoke additional credits and set the usage consumed
in the current period. A grant settles outstanding credit debt first, a revoke
never exceeds the current balance, and the monthly counter can only be changed
while the user has an active Pro plan, because the allowance belongs to a
billing period. Each adjustment writes both a `CreditTransaction` row
(`admin_credit_adjustment` / `admin_usage_adjustment`) and an audit log entry in
the same transaction.

The Stripe webhook endpoint must receive these paid-AI lifecycle events:

- `customer.subscription.created`, `customer.subscription.updated`, and
  `customer.subscription.deleted`
- `invoice.paid` and `payment_intent.succeeded`
- `charge.refunded`, `refund.created`, `refund.updated`, and `refund.failed`
- `charge.dispute.created`, `charge.dispute.updated`,
  `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, and
  `charge.dispute.funds_reinstated`

Successful transcription and translation response payloads are stored as
private AI job outputs for 30 days. The authenticated job detail and history
endpoints return their content URLs, allowing the desktop app to recover a paid
result after a lost HTTP response. Subtitle timing context is retained in the
private translation result but stripped before the text is sent to the AI
provider.
