import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260808120000_replace_subscription_credits_with_monthly_usage/migration.sql",
  import.meta.url,
);
const hardeningMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260809150000_harden_stripe_billing_state/migration.sql",
  import.meta.url,
);
const packagePaymentMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260809171000_track_package_payment_state/migration.sql",
  import.meta.url,
);
const ownershipMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260809180000_add_stripe_ownership_and_account_deletion_saga/migration.sql",
  import.meta.url,
);
const versionedOfferMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260811120000_version_paid_ai_billing_offers/migration.sql",
  import.meta.url,
);
const topUpRefundProcessingMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260811130000_add_top_up_refund_processing/migration.sql",
  import.meta.url,
);
const relaxedOwnershipMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260811120500_relax_customer_ownership_fk/migration.sql",
  import.meta.url,
);
const cancelAtMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260811121000_track_subscription_cancel_at/migration.sql",
  import.meta.url,
);
const canonicalRefundMigrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260811131000_track_canonical_refunds_and_pro_compensation/migration.sql",
  import.meta.url,
);
const billingMigrationGuideUrl = new URL(
  "../../docs/stripe-ai-billing-migration.md",
  import.meta.url,
);

describe("Stripe AI billing migration", () => {
  it("keeps the already-applied package payment migration byte-for-byte unchanged", async () => {
    const sql = await readFile(packagePaymentMigrationUrl);

    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      "87715edd43297812d231638ada5b87c8e6f88db2bef90fabb60dbb5805f4663b",
    );
  });

  it("fails before ledger mutation when unreconciled legacy purchases exist", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const addGuard = sql.indexOf(
      'ADD CONSTRAINT "CreditTransaction_no_unreconciled_legacy_purchase"',
    );
    const guardPredicate = sql.indexOf("CHECK (\"kind\" <> 'purchase')");
    const dropGuard = sql.indexOf(
      'DROP CONSTRAINT "CreditTransaction_no_unreconciled_legacy_purchase"',
    );
    const firstLedgerMutation = sql.indexOf(
      'ALTER TABLE "CreditAccount" ADD COLUMN "monthlyUsageUsed"',
    );

    expect(addGuard).toBeGreaterThanOrEqual(0);
    expect(guardPredicate).toBeGreaterThan(addGuard);
    expect(dropGuard).toBeGreaterThan(guardPredicate);
    expect(firstLedgerMutation).toBeGreaterThan(dropGuard);
    expect(sql).not.toMatch(/\bDO\s+\$\$/i);
  });

  it("enforces unique customer ownership and persists webhook watermarks", async () => {
    const [sql, packagePaymentSql] = await Promise.all([
      readFile(hardeningMigrationUrl, "utf8"),
      readFile(packagePaymentMigrationUrl, "utf8"),
    ]);

    const uniqueCustomerIndex =
      /CREATE UNIQUE INDEX "Customer_stripeId_key"\s+ON "Customer"\("stripeId"\)/;
    expect(packagePaymentSql).toMatch(uniqueCustomerIndex);
    expect(sql).not.toMatch(uniqueCustomerIndex);
    expect(sql).toContain(
      'ALTER TABLE "Subscription" ADD COLUMN "stripeEventCreatedAt"',
    );
    expect(sql).toContain(
      'ALTER TABLE "StripeCreditReversal"\nADD COLUMN "progressionRank"',
    );
    expect(sql).toContain(
      'ALTER TABLE "StripeCreditReversal"\nADD COLUMN "stripeEventCreatedAt"',
    );
  });

  it("persists immutable offer identities, durable top-ups, and Pro holds", async () => {
    const sql = await readFile(versionedOfferMigrationUrl, "utf8");

    expect(sql).toContain('CREATE TABLE "_PaidAiStripeCustomerOwnerPreflight"');
    expect(sql).toContain('CHECK ("ownerCount" = 1)');
    expect(sql).toContain('GROUP BY "stripeId"');
    expect(sql).toContain('HAVING count(*) > 1');
    expect(sql.indexOf("_PaidAiStripeCustomerOwnerPreflight")).toBeLessThan(
      sql.indexOf('CREATE TABLE "BillingOffer"'),
    );
    expect(sql).toContain('CREATE TABLE "BillingOffer"');
    expect(sql).toContain('"stripePriceId" STRING NOT NULL');
    expect(sql).toContain('AND "creditAmount" IS NOT NULL');
    expect(sql).toContain('AND "recurringIntervalCount" IS NOT NULL');
    expect(sql).toContain('CREATE TABLE "TopUpCheckoutAttempt"');
    expect(sql).toContain(
      "deliberately has no User foreign key",
    );
    expect(sql).toContain('CREATE TABLE "SubscriptionEntitlementHold"');
    expect(sql).toContain(
      'ON "SubscriptionEntitlementHold"("userId", "stripeSubscriptionId", "active")',
    );
    expect(sql).toContain('CREATE TABLE "AiRemoteJobCleanup"');
    expect(sql).toContain(
      'ALTER TABLE "Subscription" ADD COLUMN "billingOfferId"',
    );
    expect(sql).toContain(
      'ALTER TABLE "CreditTransaction" ADD COLUMN "billingOfferId"',
    );
  });

  it("unlocks newly-created billing tables before adding their indexes and keys", async () => {
    const [versionedSql, canonicalSql] = await Promise.all([
      readFile(versionedOfferMigrationUrl, "utf8"),
      readFile(canonicalRefundMigrationUrl, "utf8"),
    ]);

    for (const [table, sql] of [
      ["BillingOffer", versionedSql],
      ["TopUpCheckoutAttempt", versionedSql],
      ["SubscriptionEntitlementHold", versionedSql],
      ["AiRemoteJobCleanup", versionedSql],
      ["BillingRefundAttempt", canonicalSql],
    ]) {
      const create = sql.indexOf(`CREATE TABLE "${table}"`);
      const unlock = sql.indexOf(
        `ALTER TABLE "${table}" SET (schema_locked = false)`,
      );
      const relock = sql.indexOf(
        `ALTER TABLE "${table}" SET (schema_locked = true)`,
      );

      expect(create).toBeGreaterThanOrEqual(0);
      expect(unlock).toBeGreaterThan(create);
      expect(relock).toBeGreaterThan(unlock);
    }
  });

  it("relocks existing billing tables after changing their offer references", async () => {
    const sql = await readFile(versionedOfferMigrationUrl, "utf8");

    for (const table of [
      "Subscription",
      "CreditTransaction",
      "ProCheckoutAttempt",
    ]) {
      const unlock = sql.indexOf(
        `ALTER TABLE "${table}" SET (schema_locked = false)`,
      );
      const relock = sql.lastIndexOf(
        `ALTER TABLE "${table}" SET (schema_locked = true)`,
      );

      expect(unlock).toBeGreaterThanOrEqual(0);
      expect(relock).toBeGreaterThan(unlock);
    }
  });

  it("preserves active legacy Pro entitlements until Stripe verifies their offer", async () => {
    const sql = await readFile(versionedOfferMigrationUrl, "utf8");
    const addOfferReference = sql.indexOf(
      'ALTER TABLE "Subscription" ADD COLUMN "billingOfferId"',
    );
    const seedLegacyOffer = sql.indexOf(
      "'legacy-pro-pre-offer-versioning-2026-08-11'",
    );
    const backfillActiveSubscriptions = sql.indexOf(
      'UPDATE "Subscription"\nSET "billingOfferId" = \'legacy-pro-pre-offer-versioning-2026-08-11\'',
    );

    expect(seedLegacyOffer).toBeGreaterThan(addOfferReference);
    expect(backfillActiveSubscriptions).toBeGreaterThan(seedLegacyOffer);
    expect(sql.slice(backfillActiveSubscriptions)).toContain(
      'AND "status" = \'active\'',
    );
    expect(sql.slice(backfillActiveSubscriptions)).toContain(
      'AND "planId" = \'pro\'',
    );
    expect(sql.slice(backfillActiveSubscriptions)).toContain(
      'AND "currentPeriodEnd" > CURRENT_TIMESTAMP',
    );
  });

  it("aborts offer versioning until every bound legacy Pro Checkout is reconciled", async () => {
    const [sql, guide] = await Promise.all([
      readFile(versionedOfferMigrationUrl, "utf8"),
      readFile(billingMigrationGuideUrl, "utf8"),
    ]);
    const guard = sql.indexOf(
      'CREATE TABLE "_BoundLegacyProCheckoutAttemptPreflight"',
    );
    const guardCheck = sql.indexOf(
      'CHECK ("stripeCheckoutSessionId" IS NULL)',
      guard,
    );
    const boundInsert = sql.indexOf(
      'WHERE "stripeCheckoutSessionId" IS NOT NULL',
      guard,
    );
    const offerMutation = sql.indexOf('CREATE TABLE "BillingOffer"');
    const safeCleanup = sql.indexOf(
      'DELETE FROM "ProCheckoutAttempt"\nWHERE "stripeCheckoutSessionId" IS NULL',
    );

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guardCheck).toBeGreaterThan(guard);
    expect(guardCheck).toBeLessThan(boundInsert);
    expect(boundInsert).toBeGreaterThan(guard);
    expect(boundInsert).toBeLessThan(offerMutation);
    expect(safeCleanup).toBeGreaterThan(offerMutation);
    expect(sql).not.toMatch(/DELETE FROM "ProCheckoutAttempt"\s*;/);
    expect(guide).toContain(
      'WHERE "stripeCheckoutSessionId" IS NOT NULL',
    );
    expect(guide).toContain("fully refund every paid PaymentIntent");
    expect(guide).toContain(
      "Delete the corresponding `ProCheckoutAttempt` row only after that terminal",
    );
  });

  it("adds leased top-up refund processing in a later migration", async () => {
    const sql = await readFile(topUpRefundProcessingMigrationUrl, "utf8");

    expect(sql).toContain('ADD COLUMN "refundNotBefore" TIMESTAMP(3)');
    expect(sql).toContain('ADD COLUMN "refundLeaseToken" STRING');
    expect(sql).toContain('ADD COLUMN "refundLeaseExpiresAt" TIMESTAMP(3)');
    expect(sql).toContain('ADD COLUMN "refundAttempts" INT4 NOT NULL DEFAULT 0');
    expect(sql).toContain('ADD COLUMN "refundInterventionAt" TIMESTAMP(3)');
    expect(sql).toContain("'refund_not_required'");
    expect(sql).toContain(
      'UPDATE "TopUpCheckoutAttempt"\nSET "refundNotBefore" = CURRENT_TIMESTAMP',
    );
    expect(sql).toContain(
      'CREATE INDEX "TopUpCheckoutAttempt_status_refundNotBefore_refundLeaseExpiresAt_idx"',
    );
  });

  it("snapshots legacy ownership and adds the deletion saga in a later migration", async () => {
    const [sql, relaxedSql] = await Promise.all([
      readFile(ownershipMigrationUrl, "utf8"),
      readFile(relaxedOwnershipMigrationUrl, "utf8"),
    ]);

    expect(sql).toContain('CREATE TABLE "StripeCustomerOwnership"');
    expect(sql).toContain(
      'CHECK ("migrationCohort" IS NOT NULL OR "verifiedAt" IS NOT NULL)',
    );
    expect(sql).toContain(
      "'pre-owner-metadata-2026-08-09',\n    NULL,",
    );
    expect(sql).toMatch(
      /INSERT INTO "StripeCustomerOwnership"[\s\S]+FROM "Customer";/,
    );
    expect(sql).toContain(
      'FOREIGN KEY ("stripeId", "userId")\nREFERENCES "StripeCustomerOwnership"("stripeId", "userId")',
    );
    expect(sql).toContain('CREATE TABLE "AccountDeletionIntent"');
    expect(sql).toContain(
      'PRIMARY KEY ("identifier", "tokenHash")',
    );
    expect(sql).toContain(
      'ADD COLUMN "stripeCanonicalObservedAt" TIMESTAMP(3)',
    );
    expect(relaxedSql).toContain(
      'DROP CONSTRAINT IF EXISTS "Customer_stripeId_userId_fkey"',
    );
  });

  it("persists Stripe's effective custom subscription cancellation time", async () => {
    const sql = await readFile(cancelAtMigrationUrl, "utf8");

    expect(sql).toContain(
      'ALTER TABLE "Subscription"\nADD COLUMN "cancelAt" TIMESTAMP(3)',
    );
  });

  it("deactivates null-period legacy holds before enforcing canonical holds", async () => {
    const sql = await readFile(canonicalRefundMigrationUrl, "utf8");
    const addCanonicalColumns = sql.indexOf(
      'ADD COLUMN "stripeCanonicalObservedAt" TIMESTAMP(3)',
    );
    const deactivateLegacyHolds = sql.indexOf(
      'UPDATE "SubscriptionEntitlementHold"\nSET\n    "active" = false',
    );
    const enforceCanonicalHolds = sql.indexOf(
      'ADD CONSTRAINT "SubscriptionEntitlementHold_active_canonical_check"',
    );

    expect(deactivateLegacyHolds).toBeGreaterThan(addCanonicalColumns);
    expect(enforceCanonicalHolds).toBeGreaterThan(deactivateLegacyHolds);
    expect(sql).toMatch(
      /WHERE "active" = true[\s\S]+"billingPeriodStart" IS NULL[\s\S]+"billingPeriodEnd" IS NULL[\s\S]+"paymentAmount" IS NULL[\s\S]+"reversalAmount" IS NULL/,
    );
    expect(sql).toContain('NOT "active"');
    expect(sql).toContain('"reversalAmount" >= "paymentAmount"');
  });
});
