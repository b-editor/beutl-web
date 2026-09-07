# Deployment configuration

This document records configuration and operational requirements shared by the
three Cloudflare Workers. Worker routes and deploy commands are listed in the
root [README](../README.md#deployment).

## Configuration sources

Cloudflare bindings are declared alongside each deployable application:

- Web: [`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc)
- Desktop API: [`packages/api/wrangler.jsonc`](../packages/api/wrangler.jsonc)
- Admin: [`apps/admin/wrangler.jsonc`](../apps/admin/wrangler.jsonc)

Local environment placeholders are documented in
[`apps/web/.env.sample`](../apps/web/.env.sample) and
[`apps/admin/.env.sample`](../apps/admin/.env.sample). Store production secrets
in Cloudflare and local Worker secrets in ignored `.dev.vars` files; never
commit secret values.

`JWT_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE` must match between the Web and
desktop API Workers. The Web Worker issues the JWTs that the API Worker
validates.

## Database migrations

The schema is versioned in [`apps/web/prisma/migrations`](../apps/web/prisma/migrations)
and every environment is migrated with Prisma Migrate. Production receives new
migrations through `prisma migrate deploy`. Do not apply a `migration.sql` by
hand and do not run `prisma db push`: neither records the migration in
`_prisma_migrations`, so the next `migrate deploy` would try to apply it again
and fail on the objects that already exist.

Locally, `prisma migrate dev` creates and applies migrations against
`DATABASE_URL` in `apps/web/.env`. The commands below never use that URL as a
target. They take the target from `MIGRATE_DATABASE_URL`, and the drift check
takes a dedicated empty Cockroach database from `MIGRATE_SHADOW_DATABASE_URL`,
so a forgotten variable fails instead of migrating the wrong cluster. Pass
production URLs on the command line rather than storing them in `.env`.

| Command | Purpose |
| --- | --- |
| `pnpm migrate:status` | Show which migrations the target records |
| `pnpm migrate:diff` | Print the SQL that would bring the target in line with the migration history; exit code 2 means drift |
| `pnpm migrate:baseline` | One-time: record the history as applied on a database that received it by hand |
| `pnpm migrate:deploy` | Apply pending migrations; refuses a database that records no history |
| `pnpm migrate:fresh-cockroach` | Bootstrap an empty Cockroach database (see [Fresh Cockroach bootstrap](stripe-ai-billing-migration.md#fresh-cockroach-bootstrap)) |

Release order: run the migration before deploying the Workers, unless the
notes for that migration in [Stripe AI billing migration safety](stripe-ai-billing-migration.md)
require a maintenance cutover, in which case follow that order.

```bash
MIGRATE_DATABASE_URL='postgresql://user@host:26257/db?sslmode=verify-full' \
  pnpm migrate:deploy
```

### One-time baseline of the production database

Production was migrated by applying each `migration.sql` by hand. Its schema
therefore matches the history, but `_prisma_migrations` does not exist, and
`migrate deploy` would try to start from `20260302104549_init`. Record the
history once:

1. Run the baseline. The shadow database must be a dedicated empty database
   (the development shadow database is fine); it is reset on every run.

   ```bash
   MIGRATE_DATABASE_URL='…' MIGRATE_SHADOW_DATABASE_URL='…' pnpm migrate:baseline
   ```

   The command first replays the history into the shadow database and
   compares production against it. On CockroachDB Cloud every statement is a
   schema-change job, so the replay takes 20 minutes or more; `SHOW JOBS` on
   the shadow database shows progress. With no difference it runs
   `prisma migrate resolve --applied` for every migration and ends with
   `prisma migrate status`. It is resumable: migrations that are already
   recorded are kept.
2. If the command stops because production differs, it has printed the SQL
   that would bring production in line, followed by a drift fingerprint.
   Apply that SQL by hand and rerun. If the difference is exactly the content
   of migrations that were never applied, do not apply them by hand: set
   `MIGRATE_BASELINE_THROUGH` to the last migration that was applied, rerun,
   and let `migrate:deploy` apply the rest afterwards. If a reviewed
   difference is to be kept, rerun with `MIGRATE_BASELINE_ACCEPT_DRIFT` set
   to the printed fingerprint; the command records the history only when the
   drift is still exactly that script. `pnpm migrate:diff` runs the same
   comparison on its own.
3. Release with `pnpm migrate:deploy` from then on.

#### Known differences kept in production

Production was created by `prisma db push`, so it lacked every `CHECK`
constraint of the history, used `INT4` where the migration SQL writes `INT`
(`INT8`), and carried Prisma's default index names. Those were aligned by hand
on 2026-09-07 with [production-align-2026-09-07.sql](production-align-2026-09-07.sql).
One difference remains: the history declares
`DEFAULT gen_random_uuid()` on the `STRING` id columns of `BillingOffer`,
`BillingRefundAttempt`, `SubscriptionEntitlementHold`, and
`TopUpCheckoutAttempt`, which CockroachDB accepts in `CREATE TABLE` but not in
`ALTER COLUMN`. Production carries the equivalent `gen_random_uuid()::STRING`,
which Prisma reports as four `SET DEFAULT` statements. The baseline accepted
that drift by fingerprint (`a99f99cc1d024c06`), and `pnpm migrate:diff` keeps
reporting it.

The comparison covers tables, columns, indexes, foreign keys, and enums. It
does not cover the `CHECK` constraints or the `schema_locked` state that the
migration SQL sets by hand (verified against Prisma 7.9: a replayed history
with 84 `CHECK` constraints diffs cleanly against a schema without them), so
the `SHOW CREATE TABLE` checks in the billing migration notes remain the
verification for those.

The replay into the shadow database appends `create_table_with_schema_locked=off`
to the shadow URL only, because the historical `20260302201320` migration needs
it on a fresh chain, and first unlocks tables that a previous replay left
locked. Neither change touches the target database.

## Admin authentication and session sharing

The admin console can share the Better Auth session with the Web app through
`crossSubDomainCookies`. Session sharing is enabled only when
`BETTER_AUTH_COOKIE_DOMAIN` is set.

- Leave `BETTER_AUTH_COOKIE_DOMAIN` unset during local development. Each
  Worker then uses a host-only session cookie and does not share sessions.
- In production, set it to the narrowest domain covering both Workers:
  `beutl.beditor.net`.
- Do not use `beditor.net`. That would send the session cookie to unrelated
  hosts below the root domain.
- Configure the same `BETTER_AUTH_SECRET` and Google/GitHub OAuth client IDs on
  the Web and admin Workers.
- Register OAuth redirect URIs for `admin.beutl.beditor.net` with each provider.
- Restrict admin access with the comma-separated user IDs in `ADMIN_USER_IDS`.

Adding a `Domain` attribute does not replace an existing host-only cookie; the
browser can send both entries during rollout. Explicitly expire existing
host-only session cookies when enabling session sharing.

## Paid AI

### Worker settings

The Web Worker requires:

- `STRIPE_SECRET_KEY`
- `STRIPE_PRO_PRICE_ID` for the monthly Pro subscription
- `STRIPE_CREDIT_PRICE_ID` for the one-time 500-unit top-up
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`, pointing to an active portal
  configuration that disables price switching and cancels at period end
- `STRIPE_PRO_HISTORICAL_OFFERS`, containing immutable `priceId:productId`
  pairs for rotated Pro offers

Historical offers are explicit rather than learned from a customer-edited
subscription.

The desktop API Worker requires:

- `OPENROUTER_API_KEY`
- `OPENROUTER_WEBHOOK_SECRET`, used to verify callbacks that reconcile
  ambiguous video submissions
- `STRIPE_SECRET_KEY`, used by scheduled top-up and Pro refund reconciliation
- `OPENROUTER_REQUEST_TIMEOUT_MS` when overriding the default 120-second
  provider deadline

Without `STRIPE_SECRET_KEY`, the API Worker's scheduled billing reconcilers
fail and compensating refunds stop being issued. Use the same Stripe secret as
the Web Worker.

The admin Worker can read current prices from Stripe before the first sale.
Configure `STRIPE_PRO_PRICE_ID`, `STRIPE_CREDIT_PRICE_ID`, and a restricted
`STRIPE_SECRET_KEY` that grants only `prices: read`. The admin console has no
reason to hold a key capable of moving money. When these settings are absent,
the console falls back to a recorded `BillingOffer` when available and marks
the fallback; it also flags disagreements between Stripe and stored terms.
Purchases continue to settle against the stored terms.

### Models, prices, and allowances

An operation can offer several models, each with its own usage-unit price. The
caller selects one through `model` in a v3 request or the corresponding
dashboard field. Omitting the field selects the operation's default. Unknown
or disabled models are rejected instead of silently replaced, preventing a
caller from being charged for a model it did not request.

Administrators register models per operation at `/admin/ai`. They are stored
in `AiOperationModel`. An operation with no registered models uses the single
model and price in `AiSetting`; the monthly Pro allowance is configured there
as well. Values resolve from the database or their built-in defaults, including
the default allowance of 500 units per period. Each settings change and account
adjustment is written to the audit log in the same transaction as the change.

Clients discover models through `GET /api/v3/ai/capabilities`. It exposes model
names and relative expense (`costTier`: `low`, `medium`, or `high`) without
prices. `GET /api/v3/user/entitlements` exposes affordability through
`modelAvailability`. Prices and secret values never leave the server.

Price and allowance changes affect only operations started afterwards. Each
job records the price reserved at its start and uses that same price for a
refund. Changing the allowance does not alter usage already consumed in the
current billing period.

### Admin reporting and adjustments

The AI settings page shows:

- how many runs of each operation an allowance buys;
- the monetary value of one unit for allowances and purchased credits; and
- estimated provider cost and the resulting cost ratio.

Provider costs come from OpenRouter's public price endpoints and require no
provider credential on the admin Worker. They are rate-card estimates, not
recorded spend. When a token rate must be converted to another unit, the UI
states the assumption. An indeterminate unit is reported as unknown rather
than free.

`/admin/ai/usage` reports jobs and units for a selected window, current account
balances, heavy consumers, and allowance consumption statistics. The
distribution uses only current billing periods because an expired period's
counter is not cleared until the account next runs a job.

Administrators can grant or revoke purchased credits and correct current-period
usage from `/admin/users/<id>`. A grant settles credit debt first, a revoke
cannot exceed the current balance, and monthly usage can be changed only for an
active Pro plan. Each adjustment writes a `CreditTransaction`
(`admin_credit_adjustment` or `admin_usage_adjustment`) and an audit log entry
in the same transaction.

### Promotion codes

Pro and credit top-up Checkout Sessions accept active Stripe promotion codes.
Create and constrain them in the Stripe Dashboard; package-store checkout does
not accept them. A top-up promotion must leave a positive amount payable because
credit fulfillment depends on a successful PaymentIntent. Do not make a
100%-off promotion eligible for the top-up Price.

### Stripe webhook events

The Stripe webhook endpoint must receive these Paid AI lifecycle events:

- `customer.subscription.created`, `customer.subscription.updated`, and
  `customer.subscription.deleted`
- `invoice.paid` and `payment_intent.succeeded`
- `charge.refunded`, `refund.created`, `refund.updated`, and `refund.failed`
- `charge.dispute.created`, `charge.dispute.updated`,
  `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, and
  `charge.dispute.funds_reinstated`

### Result retention

Successful transcription and translation payloads are stored as private AI
job outputs for 30 days. Authenticated job-detail and history endpoints return
their content URLs so the desktop app can recover a paid result after a lost
HTTP response. Private translation results retain subtitle timing context, but
that context is removed before text is sent to the AI provider.
