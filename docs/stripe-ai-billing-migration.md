# Stripe AI billing migration safety

The AI top-up feature was not deployed before
`20260808120000_replace_subscription_credits_with_monthly_usage`. The migration
therefore expects no legacy `CreditTransaction` rows whose `kind` is
`purchase`.

The migration deliberately installs and immediately removes a portable `CHECK`
constraint before changing the ledger. PostgreSQL and CockroachDB validate the
constraint against existing rows when it is added, so an unexpected legacy
purchase stops the migration instead of being trusted without Stripe payment
amount and currency provenance.

Before applying the migration, operators can run:

```sql
SELECT "id", "userId", "stripePaymentId", "createdAt"
FROM "CreditTransaction"
WHERE "kind" = 'purchase';
```

An empty result is the expected precondition. If rows exist, stop and reconcile
each purchase against Stripe before retrying the migration. Do not bypass the
guard or delete purchases without an explicit balance and refund/dispute
reconciliation plan.

The later hardening migration also creates a unique index on
`Customer.stripeId`. Before creating it, the migration deterministically kept
one local mapping for each duplicated Stripe customer and removed the others.
That cleanup enforced uniqueness, but it could not prove that the retained
local user actually owned a metadata-free Stripe customer.

## Legacy customer ownership cohort

`20260809180000_add_stripe_ownership_and_account_deletion_saga` is a separate,
forward-only migration. It snapshots the exact `(Customer.stripeId,
Customer.userId)` pairs present at deployment into `StripeCustomerOwnership`
with migration cohort `pre-owner-metadata-2026-08-09`, then adds a composite
foreign key. The forward-only
`20260811120500_relax_customer_ownership_fk` migration removes that enforcing
foreign key before rollout. This expand step lets an older application instance
continue writing `Customer` while new instances dual-write ownership evidence;
new runtime reads treat a mapping without that evidence as unowned.

### Mandatory maintenance cutover

The ownership migration and the later FK-removal migration have already been
applied in development, so their checksums are immutable. On a fresh production
database, Prisma necessarily applies the FK before it reaches the forward-only
removal. The old application does not dual-write `StripeCustomerOwnership`, so
billing writes must not run between those two migration records.

Use this deployment order:

1. Put checkout, billing-portal, and Stripe-webhook routes into maintenance mode.
   Return a retryable response for Stripe webhooks so Stripe redelivers them.
2. Run `prisma migrate deploy` to completion. Do not resume traffic after a
   partially applied migration batch.
3. Verify that the transitional constraint is absent:

   ```sql
   SELECT 1
   FROM information_schema.table_constraints
   WHERE constraint_name = 'Customer_stripeId_userId_fkey';
   ```

   The expected result is no rows.
4. Deploy the new application and Worker, then resume billing traffic.

This maintenance window is required only for the migration batch containing
the transitional FK. Subsequent forward migrations do not recreate it.

New and replacement mappings are written in one retryable database transaction with a
non-null `verifiedAt`, and only after Stripe returns the owner metadata supplied
while creating the customer. Existing cohort rows remain as audit evidence if
the current mapping is replaced. They are not ownership proof: the earlier
customer-deduplication migration could not prove which local user owned a
metadata-free Stripe customer.

Runtime ownership is deliberately fail-closed:

- matching Stripe owner metadata plus the current database mapping is accepted
  and marks the ownership row as verified;
- absent, partial, or conflicting owner metadata is never accepted for email
  changes, billing portal access, checkout reuse, webhook entitlement, or
  account deletion;
- a live mapping whose Stripe customer lacks valid metadata is not replaced
  automatically. Billing and account-deletion operations fail closed until an
  operator reconciles ownership and any payable remote state; the legacy
  customer remains untouched during that intervention.

Before replacing a mapping, the application expires every owned open Checkout
Session on the old customer. If mapping persistence still loses a race with
account-deletion authorization, it removes the newly created unmapped customer
after confirming that it did not become the current mapping.

Operators can inspect the cohort with:

```sql
SELECT "stripeId", "userId", "migrationCohort", "verifiedAt"
FROM "StripeCustomerOwnership"
ORDER BY "createdAt", "stripeId";
```

## Open legacy package PaymentIntents

A metadata-free legacy PaymentIntent is not adopted or reused. New checkout
always uses a metadata-owned customer and writes owner metadata to the payment.
Webhook fulfillment requires that strong evidence and otherwise fails closed;
operators must reconcile any pre-deployment open PaymentIntent directly in
Stripe instead of assigning it from the migration cohort.

## Bound legacy Pro Checkout Sessions

`20260811120000_version_paid_ai_billing_offers` cannot infer an immutable
`BillingOffer` for a legacy `ProCheckoutAttempt`. Unbound attempts are safe for
the migration to remove, but a bound attempt can still name a payable Stripe
Checkout Session. The migration therefore has a fail-fast `CHECK` preflight and
will not delete a bound row.

Keep checkout traffic paused and run this before applying the migration:

```sql
SELECT "userId", "checkoutKey", "stripeCheckoutSessionId", "expiresAt"
FROM "ProCheckoutAttempt"
WHERE "stripeCheckoutSessionId" IS NOT NULL
ORDER BY "userId";
```

An empty result is the required precondition. For every returned row, retrieve
the exact Checkout Session from Stripe and verify its customer, Pro mode, owner
metadata, Price, and Subscription metadata before mutating it. Reconcile by
Stripe status:

- expire an `open` Session, then re-retrieve it and confirm it is `expired`;
- if expiry loses to completion, or the Session is already `complete`, retain
  the customer, Session, Subscription, Invoice, and every paid PaymentIntent
  handle, cancel the Subscription, and fully refund every paid PaymentIntent;
- treat only a Stripe-confirmed `expired` Session, or a canceled and fully
  refunded completed Session, as terminal.

Delete the corresponding `ProCheckoutAttempt` row only after that terminal
state has been verified and recorded in the deployment log. Re-run the query
until it is empty, then retry `prisma migrate deploy`. Do not bypass the guard,
null the binding, or delete the row merely because its local `expiresAt` has
passed; Checkout remains remotely payable until Stripe says otherwise.

## Legacy active Pro subscriptions

The same offer-versioning migration assigns currently active legacy Pro rows to
a non-checkout migration offer. That sentinel preserves the entitlement the
previous application already granted while avoiding a guess about a Stripe
Price from SQL alone. It cannot be selected in Checkout. The first canonical
Stripe subscription read resolves the exact Price and replaces the sentinel
with the verified active or historical offer.

CockroachDB installations that default new tables to `schema_locked = true`
must keep the migration SQL's explicit temporary unlocks. The migration unlocks
each newly created billing table before it adds indexes or foreign keys and
relocks it after the schema change completes. Do not manually mark a partially
applied migration as complete; first recover its incomplete tables, then retry
the corrected migration through Prisma.

## Fresh Cockroach bootstrap

The historical migration `20260302201320_change_bigint_to_int` contains a
Cockroach-incompatible statement on a fresh chain: with the cluster default
`create_table_with_schema_locked = true`, Prisma can report P3018 before later
migrations run. Do not edit that historical migration or mark it applied; its
checksum is part of the migration history. Existing production upgrades do not
re-run an already applied migration, so this is a fresh-database bootstrap
concern only.

For a new Cockroach v26.1+ database, use the dedicated command below. It
requires a separately provisioned empty database URL and changes only the
migration subprocess URL; the runtime `DATABASE_URL` remains unchanged:

```bash
FRESH_COCKROACH_DATABASE_URL='postgresql://root@host:26257/new_empty_db?sslmode=verify-full' \
  vp run --workspace-root migrate:fresh-cockroach
```

The command appends the session option
`options=-c%20create_table_with_schema_locked%3Doff` (Cockroach's actual v26.3
session variable is `create_table_with_schema_locked`) while preserving any
existing query parameters. It must not be added to the normal runtime or
upgrade URL, because turning schema locking off globally weakens the intended
schema-ownership guard. After deployment, verify the explicit relocks (and
investigate any application table that is still unlocked):

```sql
SHOW CREATE TABLE "PackageCheckoutResolution";
SHOW CREATE TABLE "TopUpDuplicateRefundAttempt";
SHOW CREATE TABLE "TopUpCheckoutResolution";
SHOW CREATE TABLE "StorageUpload";
```

Each result must include `WITH (schema_locked = true)`. Repeat `SHOW CREATE
TABLE` for the other application tables listed by `SHOW TABLES`; an application
table whose result lacks that clause is an incomplete relock and must be
repaired before traffic resumes.

The durable storage-upload start migration requires a maintenance cutover.
`20260825160000_durable_storage_upload_start` is immutable and defaults
`StorageUpload.startState` to `intent` while enforcing that only `active` rows
have a non-null `uploadId`; an old writer that omits `startState` therefore
cannot write during this transition. Quiesce storage-upload starts before
running `prisma migrate deploy` through `20260826000000_repair_storage_upload_start_default`.
Verify that the repaired default is `active`, the three start-state checks are
present, and `SHOW CREATE TABLE "StorageUpload"` reports
`schema_locked = true`. Deploy the new runtime (which writes `intent`
explicitly), then resume storage traffic. Do not edit or resolve the 1600
migration to change its checksum; the 2600 migration is the forward repair for
databases where 1600 was already applied.

The receipt-retention migration preflights orphaned and duplicate receipts,
then drops and recreates its named index and foreign key because Cockroach does
not support conditional dynamic DDL in a migration block. Run it during the
maintenance window with no concurrent storage-upload writes. If any migration
fails after its temporary unlock, do not resume traffic: retry the migration
and confirm `SHOW CREATE TABLE` reports `schema_locked = true` before release.

## Resumable account deletion

An account-deletion link now consumes its confirmation token and creates an
`AccountDeletionIntent` in the same transaction before any Stripe mutation. The
intent snapshots the Stripe customer ID. Reusing the same link finds that
authorization first, so a crash, Stripe outage, or later token expiration does
not prevent resumption. The durable authorization itself expires after seven
days; an unfinished saga then requires a newly issued confirmation link.

Stripe subscription cancellation and customer deletion remain idempotent. Only
after closure succeeds does one local transaction enqueue all R2 object cleanup
records and delete the user. A metadata-free pre-deployment customer blocks the
remote closure step and requires operator reconciliation; the cohort alone is
never used to authorize destructive Stripe operations.

Deletion authorization also expires any Pro checkout attempt without erasing
its bound Stripe Session ID. A bind that races authorization records that handle
but returns a deletion-specific result, so the checkout action validates and
expires the Session instead of redirecting to it. If Checkout completes during
expiry, cancellation and full-refund work is persisted outside the User cascade
before the local binding is removed.

## Equal-second subscription observations

Stripe event creation timestamps have one-second precision. The subscription
watermark now also stores when the handler retrieved the canonical Stripe
object. Reversible states such as `active`, `past_due`, `paused`, and `unpaid`
follow the later canonical observation instead of a restrictive status rank.
Only `canceled` and `incomplete_expired` remain irreversible and monotonic.
Custom Stripe `cancel_at` values are stored separately from the billing-period
end. Entitlement and account displays use the earlier timestamp, while monthly
usage accounting keeps the original billing period so resuming a cancellation
cannot reset the allowance.

## Authorized Pro offers and portal configuration

Only `STRIPE_PRO_PRICE_ID` and immutable `priceId:productId` pairs explicitly
listed in `STRIPE_PRO_HISTORICAL_OFFERS` can grant Pro entitlement. A Price seen
on a customer-edited subscription is never learned as an offer. The configured
billing portal must be active, cancel at period end, and have subscription price
switching disabled; its ID is supplied through
`STRIPE_BILLING_PORTAL_CONFIGURATION_ID`.

## Repairing subscriptions stranded by a refund

A refund issued together with a cancellation only reaches the database through
the subscription lifecycle events. If one of those is missed, the local row keeps
its last non-terminal status while Stripe reports the subscription as canceled.
That row then grants AI access until its stored period elapses, and it used to
block the customer from subscribing again.

Two changes close this. Pro checkout now derives the blocking decision from
Stripe rather than the stored row, and refund webhooks re-read the canonical
subscription and persist a terminal status when Stripe has ended it.

Rows stranded before that fix still need a one-off repair:

```bash
pnpm --filter @beutl/web reconcile:stale-subscriptions          # report only
pnpm --filter @beutl/web reconcile:stale-subscriptions --apply  # write
```

The script inspects every non-terminal subscription, retrieves the canonical
object from Stripe, and writes back the terminal status and billing period. A
subscription Stripe no longer recognizes is reconciled as canceled, matching
the account-page and webhook recovery paths.
