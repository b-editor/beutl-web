# AI actual-cost billing

AI usage is settled from the provider's actual USD charge instead of a fixed
per-model unit price.

## Formula

Each job snapshots two administrator-controlled values when it starts:

- the shared provider USD value of one usage unit; and
- the selected model's usage percentage.

The successful charge is:

```text
ceil_to_6_decimals(actual provider USD / USD per usage unit * model percentage / 100)
```

For example, with `$0.01` per unit, a `$0.04` request costs 6 units at 150%,
4 units at 100%, and 2 units at 50%; a `$0.001` request costs 0.1 unit at 100%.
Calculations preserve the provider's decimal cost, apply the rate and percentage,
then round up once at one-millionth of a usage unit. For example, `$0.00345678`
at `$0.01` per unit and 100% consumes exactly `0.345678` units. The legacy
`providerCostUsdMicros` audit field is rounded to micro-USD and is not an input
to this calculation. Costs above its legacy INT4 capacity ($2,147.483647) leave
that optional audit field null; a valid usage charge still settles normally.
Balances, ledger deltas, reservations, and settled job
charges are stored as exact `DECIMAL(16,6)` values. Balance checks compare
integer micro-units so an exactly sufficient fractional balance is accepted.

## Provider evidence

- Vercel AI Gateway returns each request's cost in
  `providerMetadata.gateway.cost` ([pricing exercise](https://vercel.com/academy/ai-gateway/ai-gateway-pricing)).
- OpenRouter image and video responses publish `usage.cost`; its
  [image documentation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
  and [video status documentation](https://openrouter.ai/docs/api/api-reference/video-generation/get-videos)
  define that field in USD. Chat and transcription SDK response types expose
  the same usage cost.

Provider metadata is validated as a finite, non-negative number before it can
affect the ledger. It is never returned to ordinary clients.

## Reservation and settlement

Before calling a provider, the service reserves 120% of the current public
price estimate for the submitted request: image reference count, video
resolution and audio setting, and aspect ratio where token pricing depends on
pixel count. OpenRouter image prices are restricted to endpoints that support
the submitted shape. Model-wide maximum-shape estimates remain for the admin
catalog, not for billing a cheaper request. Source-video operations that inherit
an unknown output shape retain the applicable source-video estimate rather than
assuming the generation defaults.

`POST /api/v3/user/ai-availability` accepts optional `referenceImages` (a count),
`aspectRatio`, and `background` for image generation, and `resolution`,
`generateAudio`, and `aspectRatio` for video generation. Send the same shape as
the eventual generation request. Omitted fields use the generation defaults:
zero references and 1:1 for images, or 720p, audio enabled, and 16:9 for videos.

The job separately records the unbuffered request estimate. On success,
result persistence, job completion, and the ledger delta commit in one database
transaction:

- an actual cost releases or adds units until the formula above is met;
- a response without actual cost settles to the unbuffered request estimate,
  not the temporary 120% reservation; and
- an unexpected overrun consumes remaining allowance and purchased credits,
  then records any shortfall as purchased-credit debt for the next top-up.

Provider failures refund the full reservation. Jobs created by a pre-migration
Worker have no conversion snapshot and retain their original fixed charge when
a newer Worker finalizes them.

The legacy `AiOperationModel.priceUnits` column remains temporarily for legacy
jobs and as a last-resort quote fallback. It is no longer editable or
used when a provider price or actual cost is available. New rows write `1` to
that compatibility column.

## Migration cutover

The fractional-ledger migration requires a maintenance window. It copies values
to new columns and swaps them; a write to an old column between the copy and
swap would be lost. `schema_locked` controls DDL, not application writes. Old
Workers also expect integer columns and must not resume after this cutover.

The already-applied migrations `20260921010000_add_actual_ai_cost_billing` and
`20260921020000_fractional_ai_usage_units` keep their original SQL and checksums.
`20260921005000_unlock_ai_cost_billing_tables` runs before them on an unupgraded
database, and `20260921030000_relock_ai_cost_billing_tables` locks all four
billing tables afterwards. On databases that already applied the original two,
Prisma applies only the missing lock repairs.

For an existing database with the preceding migration chain applied:

1. Run `vp run migrate:ai-usage --check` against the intended `DATABASE_URL`.
   It lists pending migrations without changing the database. Use this dedicated
   command for the cutover rather than invoking `prisma migrate deploy` directly.
2. Stop new AI submissions in both Web and API. Allow existing queued, running,
   and finalizing jobs to finish or follow the existing cancellation/refund path;
   do not mark them complete or erase their reservations manually.
3. Stop and drain **all** ledger writers: Web Server Actions, API submissions and
   callbacks, scheduled job/Stripe reconcilers, Stripe webhooks and checkout
   fulfillment, and Admin usage/credit adjustments. Return retryable responses
   to webhooks and retain their delivery backlog. Verify no request, callback,
   or scheduled run is still writing before proceeding. Merely stopping new
   submissions or one local development server is insufficient.
4. Run `vp run migrate:ai-usage --writers-stopped`. This flag confirms the
   preceding operational stop; the command does not stop infrastructure itself.
   It refuses active AI jobs, applies only this cutover's pending migrations,
   compares ledger row counts and unit totals, and verifies all four schema
   locks. On failure it attempts to restore schema locks and exits nonzero;
   keep all writers stopped while recovering the failed migration.
   Revert any partially applied DDL before using Prisma's
   `migrate resolve --rolled-back` to make a failed migration pending again;
   resolving its history does not undo its SQL. Then rerun the same
   `--writers-stopped` command. If the unlock migration is already recorded as
   applied while `20260921010000_add_actual_ai_cost_billing` is still pending,
   the runner reopens `AiOperationModel` and `AiJob` before deployment and
   restores their locks on failure. It does not replay the applied unlock
   migration, edit its checksum, or resolve failed history automatically.
5. Deploy the updated Web, API, and Admin builds (including the regenerated
   Prisma client), verify the nine usage columns are `DECIMAL(16,6)`, then resume
   traffic and scheduled work and let the webhook backlog replay. Do not resume
   an old integer-client build against fractional balances.

When the original two migrations are already complete, the runner needs no
maintenance acknowledgement for the two lock repairs; it does not replay the
column swap. Fresh empty databases use the existing fresh-Cockroach bootstrap
command and have no runtime writers during bootstrap.
