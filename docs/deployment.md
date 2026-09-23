# Deployment configuration

This document records configuration and operational requirements shared by the
four Cloudflare Workers. Worker routes and deploy commands are listed in the
root [README](../README.md#deployment).

## Configuration sources

Cloudflare bindings are declared alongside each deployable application:

- Web: [`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc)
- Desktop API: [`packages/api/wrangler.jsonc`](../packages/api/wrangler.jsonc)
- Private image edit: [`packages/api/wrangler-ai-images.jsonc`](../packages/api/wrangler-ai-images.jsonc)
- Admin: [`apps/admin/wrangler.jsonc`](../apps/admin/wrangler.jsonc)

Local environment placeholders are documented in
[`apps/web/.env.sample`](../apps/web/.env.sample) and
[`apps/admin/.env.sample`](../apps/admin/.env.sample). Store production secrets
in Cloudflare and local Worker secrets in ignored `.dev.vars` files; never
commit secret values.

`JWT_SECRET`, `JWT_ISSUER`, and `JWT_AUDIENCE` must match between the Web and
desktop API Workers. The Web Worker issues the JWTs that the API Worker
validates.

The private image-edit Worker has a separate JWT signing key. Set the same
new random value as `AI_IMAGE_WORKER_JWT_SECRET` on `beutl-web` and
`JWT_SECRET` on `beutl-ai-images`; do not reuse the desktop API JWT secret.
The image Worker fixes `JWT_ISSUER=beutl-web-image-edit` and
`JWT_AUDIENCE=beutl-ai-images` in its Wrangler configuration. It has no
public route or workers.dev URL. Its database Hyperdrive, R2 binding, storage
configuration, and `OPENROUTER_API_KEY` / `VERCEL_AI_GATEWAY_API_KEY` secrets
must address the same production resources as Web before the Web service
binding is deployed. Other Web/API routes retain their existing behavior.

## Object storage

User files and AI outputs live in one object store that the Web Worker and the
desktop API Worker share. Both Workers must be configured for the same bucket:
the Web Worker writes uploads that the API Worker's scheduled reconcilers
inspect and clean up, and either Worker may serve or delete an object the
other one wrote. The admin Worker takes the same configuration so that
`/admin/storage` can show where each file's object lives and move it.

`BEUTL_STORAGE_PROVIDER` selects the implementation:

| Value | Storage | Configuration |
| --- | --- | --- |
| `r2` (default when unset) | Cloudflare R2 through the `BEUTL_R2_BUCKET` binding | `r2_buckets` in each `wrangler.jsonc` |
| `s3` | Any S3 compatible service over signed HTTPS | `BEUTL_S3_*` vars and secrets below |

### S3 compatible storage

Set `BEUTL_STORAGE_PROVIDER=s3` on all four Workers (Web, desktop API, admin,
and private image edit) together with:

- `BEUTL_S3_ENDPOINT`: the service URL, for example `https://s3.example.com`,
  `https://<account>.r2.cloudflarestorage.com`, or an endpoint with a path
  prefix. Workers fetch with `global_fetch_strictly_public`, so the endpoint
  must be publicly reachable.
- `BEUTL_S3_BUCKET`: the bucket name.
- `BEUTL_S3_ACCESS_KEY_ID`, `BEUTL_S3_SECRET_ACCESS_KEY`, and, for temporary
  credentials, `BEUTL_S3_SESSION_TOKEN`: all three are credentials and must be
  stored with `wrangler secret put`, never as `vars`.
- `BEUTL_S3_REGION`: the signing region. It defaults to `auto`, which R2 and
  MinIO accept; AWS S3, Backblaze B2, and Wasabi need their real region.
- `BEUTL_S3_FORCE_PATH_STYLE`: `true` (default) requests
  `https://endpoint/bucket/key`; `false` requests `https://bucket.endpoint/key`.
- `BEUTL_S3_ALLOW_INSECURE_HTTP`: an `http://` endpoint is refused unless this
  is `true`. Signed requests carry the credentials and the object data, so
  this is for a local MinIO during development only.

The credential needs `GetObject`, `PutObject`, `DeleteObject`, and the
multipart upload permissions (`CreateMultipartUpload`, `UploadPart`,
`CompleteMultipartUpload`, `AbortMultipartUpload`) on the objects, plus
`ListBucket` on the bucket itself. Nothing lists the bucket, but AWS S3 (and
services that copy its behaviour) answers a GET or HEAD of a missing key with
`403 AccessDenied` instead of `404` when the principal lacks `ListBucket`; the
adapter treats only `404` as "not here", so without that permission an object
that lives in the other store is reported as an error rather than read from it.

Use a bucket without versioning. A delete on a versioned bucket only writes a
delete marker, while the cleanup outboxes and the storage console take a
successful delete as the object being gone; the noncurrent versions would
then stay stored and billed with nothing tracking them. If versioning cannot
be turned off, add a lifecycle rule that expires noncurrent versions promptly.

Uploads stream each part straight from the browser request to the service with
an unsigned payload (`x-amz-content-sha256: UNSIGNED-PAYLOAD`). This has been
verified against MinIO, and R2 and AWS S3 document support for it; check
another provider accepts it before relying on it. Configure the bucket to abort
incomplete multipart uploads after 7 days, matching the R2 lifecycle rule that
`pnpm verify:r2-lifecycle` checks, so that an upload id whose owner never
returned is not paid for indefinitely.

### Switching providers

`BEUTL_STORAGE_PROVIDER` only decides where new objects are written. When the
other provider is configured as well (the `BEUTL_R2_BUCKET` binding for R2,
the `BEUTL_S3_*` values for S3), an object the primary does not hold is read
from the other store, and a delete is issued to both. Objects stored before
the switch therefore stay reachable without being copied: to move new uploads
to S3 while existing files keep coming from R2, set `BEUTL_STORAGE_PROVIDER=s3`
and leave the R2 binding in place. The same rule covers moving back.

A read that misses the primary costs one extra request, so move the old
objects across and remove the other provider's configuration once the
transition is over. `/admin/storage` in the admin console lists files with the
store each object was found in, moves a single file, and moves files in bulk
from the oldest onwards; each bulk run is bounded and resumes from where the
previous one stopped. A move holds a lease on the File record for its
duration (the same file cannot be moved from two places at once), copies the
object, checks the copy's size against the File record, and only then
deletes the source; each moved file is written to the audit log. A half-configured provider is an error rather than a
skipped fallback, so a stale `BEUTL_S3_*` value must be removed completely.

Multipart uploads in flight at the moment of the switch belong to the old
store. Their completion and abort are retried against it when the primary
does not know the upload id, but a part cannot be resent, so a browser that
was mid-upload sees that upload fail and the user has to start it again;
the new upload then goes to the primary.

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

Provider credentials are local to each Worker. The Web Worker executes
dashboard AI requests through `/api/internal/ai/*`; only image edits are
forwarded to the private image Worker. It does not forward them to the desktop
API Worker. All four Workers load the AI model catalog, so keep their enabled
Gateway configuration aligned:

| Setting | Web | Desktop API | Admin | Image edit |
| --- | --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | Required for OpenRouter operations | Required for OpenRouter operations and reconciliation | Not needed for public catalog and price reads | Required for OpenRouter edits |
| `VERCEL_AI_GATEWAY_API_KEY` | Required when Gateway is enabled | Required when Gateway is enabled | Required when Gateway is enabled, including built-in model visibility | Required for Gateway edits |

Configure `VERCEL_AI_GATEWAY_API_KEY` as a secret on **all four Workers** when
enabling Gateway, including an upgrade that relies on the built-in
`video.edit`, `video.extend`, and `video.motion` models before any rows have
been registered. Setting it only on the desktop API Worker leaves those modes
hidden in the Web and admin catalogs. Keep Web and desktop API credentials on
the same provider account so scheduled reconciliation can retrieve jobs
started by either Worker. Configure secrets separately for each deployed
Worker/environment; they are not inherited from another Worker.

An OpenRouter-only installation may omit the Gateway key on all four Workers;
the Gateway-only built-in modes then remain unavailable. Gateway supports
image, transcription, and translation operations as well as video, so the key
requirement is not limited to registered video models. There is no
workspace-wide Gateway webhook secret to configure.

Provider media URLs require the nonce of the job that published them. The
serving Worker checks its stored hash and the job's deletion state before
reading storage. When upgrading an earlier Gateway deployment that issued
media URLs without a nonce, let those in-flight jobs finish before rollout:
the old tokenless media URLs will return 404.

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

In addition to the provider settings above, the desktop API Worker requires:

- `OPENROUTER_WEBHOOK_SECRET`, used to verify callbacks that reconcile
  ambiguous video submissions
- `STRIPE_SECRET_KEY`, used by scheduled top-up and Pro refund reconciliation

Both providers default to a 120-second request deadline. Override it on Web
and desktop API with `OPENROUTER_REQUEST_TIMEOUT_MS` or
`VERCEL_AI_GATEWAY_REQUEST_TIMEOUT_MS` as needed.

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

An operation can offer several models, each with a provider-cost usage
percentage. The caller selects one through `model` in a v3 request or the
corresponding dashboard field. Omitting the field selects the operation's
default. Unknown or disabled models are rejected instead of silently replaced.

Administrators register models per operation at `/admin/ai`. They are stored
in `AiOperationModel`. An operation with no registered models uses its built-in
model and a 100% usage percentage, subject to the provider configuration above.
The monthly Pro allowance and shared provider-USD-per-unit conversion are
configured in `AiSetting`. Values resolve from the database or their built-in
defaults, including 500 units per period and $0.01 per unit. Each settings
change and account adjustment is written to the audit log in the same
transaction as the change.

Clients discover model names through `GET /api/v3/ai/capabilities`. The
`costTier` field remains for compatibility with older clients and is always
`null`: request-dependent provider costs cannot be ranked into fixed relative
price tiers. `GET /api/v3/user/entitlements` exposes affordability through
`modelAvailability`. Prices and secret values never leave the server.

Gateway image editing and reference-image inputs are enabled only for the
exact models in the [verified image-input compatibility list](ai-gateway-image-inputs.md).
Unlisted models remain available for plain text-to-image requests.

Before a provider request, the service reserves a buffered public-price quote.
On success it replaces that reservation with the provider-reported USD cost,
multiplied by the model's usage percentage and converted with the job's saved
USD-per-unit rate. A provider response without actual cost settles to the
unbuffered quote. Percentage and conversion changes affect only jobs started
afterwards. If actual cost exceeds the reservation, remaining allowance and
purchased credits are consumed and any shortfall becomes purchased-credit debt
that future top-ups settle first. Changing the allowance does not alter usage
already consumed in the current billing period. Usage balances, ledger deltas,
reservations, and settled charges retain six decimal places, so a provider cost
below the value of one whole unit is not rounded up to one.
See [AI actual-cost billing](ai-actual-cost-billing.md) for the formula,
provider metadata sources and fallback behavior. The fractional ledger requires
the [maintenance cutover](ai-actual-cost-billing.md#migration-cutover) using
`vp run migrate:ai-usage`; all ledger writers must be stopped until the updated
Web/API/Admin builds are deployed.

### Admin reporting and adjustments

The AI settings page shows the allowance and USD conversion settings, observed
allowance distribution, Stripe-backed offer prices, and each model's provider
and usage percentage. Per-model cost and margin projections are deliberately
not rendered.

OpenRouter costs come from public price endpoints and require no OpenRouter
credential on the admin Worker. The Gateway credential requirement for the
admin catalog is listed above. Provider costs are rate-card estimates, not
recorded spend. When a token rate must be converted to another unit, the UI
states the assumption. An indeterminate unit is reported as unknown rather
than free.

`/admin/ai/usage` reports jobs and units for a selected window, current account
balances, heavy consumers, and allowance consumption statistics. The
consumed-units total groups each job's reservation, settlement, and refund by
the job's creation time, so a later adjustment cannot appear without its
original reservation. Purchases, administrator adjustments, and legacy ledger
entries without a linked job still use their own transaction time. The
distribution uses only current billing periods because an expired period's
counter is not cleared until the account next runs a job.
Report sums may exceed a single ledger row's limit. They retain exact integer
micro-units until conversion to JavaScript numbers; unsafe totals are rejected
rather than silently losing fractional units. Individual ledger row limits
remain unchanged.

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

### Storage plan

The storage plan is a second Stripe subscription on the same customer,
independent of AI Pro. A user can hold both. Every plan lives in the same
tables: `Subscription` and `SubscriptionCheckoutAttempt` are keyed by
`(userId, planId)`, and a plan that sells several sizes records the size in
the `tier` column (`BillingOffer.tier` for the Price, `Subscription.tier` for
the contract). The webhook, checkout, portal sync, refund holds, cleanup
reconciler, and account deletion take the plan from `metadata.planId`
(missing means AI Pro) and run the same code for every plan; the plan
registry is `SUBSCRIPTION_PLANS` in `packages/core/src/subscription-plans.ts`
and the Stripe-side Price mapping is `apps/web/src/lib/stripe/subscription-plans.ts`.
Adding a tier to AI Pro later means adding tier ids to the registry and a
Price per tier to that mapping, not new tables. Adding a whole plan also
needs its id in the `StripeCheckoutCleanup_kind_check` constraint (see
`docs/stripe-ai-billing-migration.md`).

The Web Worker requires one monthly recurring Price per storage tier:

- `STRIPE_STORAGE_PRICE_ID_100GB`
- `STRIPE_STORAGE_PRICE_ID_200GB`
- `STRIPE_STORAGE_PRICE_ID_1TB`
- `STRIPE_STORAGE_HISTORICAL_OFFERS`, containing immutable
  `priceId:productId:tier` triples for rotated storage Prices

Only these Prices can grant storage entitlement. The tier of record is always
resolved from the Price (`BillingOffer.tier`); the `tier` metadata on a
subscription is informational. All Prices must share one currency. The API
Worker needs nothing new.

Tier quotas are code constants in `packages/core/src/storage-plan.ts`
(100 GiB, 200 GiB, 1 TiB; 100,000 files) and are not configurable from the
admin console. The free quota stays 1 GiB / 10,000 files. A single upload is
capped at 10,000 multipart parts of 16 MiB (160,000 MiB, about 156 GiB)
regardless of tier.

Tier changes are made by the `changeStorageTier` action, not through the
customer portal: the subscription item is switched with
`proration_behavior: always_invoice` and `payment_behavior:
error_if_incomplete`, so the difference is charged immediately and a declined
or 3DS-gated card leaves the subscription unchanged. Keep the portal
configuration as documented for Paid AI (cancel at period end, no price
switching); the storage row cancels through the portal's
`subscription_cancel` deep link for its own subscription id.

When a storage subscription lapses while the account is over the free quota,
existing files remain readable, downloadable, and deletable. Only new uploads
are refused until the account is back under quota or subscribes again.
Nothing is deleted automatically.

The webhook endpoint needs no additional event types; the Paid AI set covers
storage subscriptions, invoices, refunds, and disputes. A refunded or disputed
storage invoice places a `SubscriptionEntitlementHold` on the storage
subscription only.

### Result retention

Successful transcription and translation payloads are stored as private AI
job outputs for 30 days. Authenticated job-detail and history endpoints return
their content URLs so the desktop app can recover a paid result after a lost
HTTP response. Private translation results retain subtitle timing context, but
that context is removed before text is sent to the AI provider.
