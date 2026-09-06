import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../apps/web/prisma/migrations/20260826050000_harden_topup_checkout_recovery/migration.sql",
  import.meta.url,
);

describe("durable top-up Checkout hardening migration", () => {
  it("persists one active owner slot, exact Stripe identity, and a create lease", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain('"activeOwnerKey" STRING');
    expect(sql).toContain('"checkoutKey" STRING');
    expect(sql).toContain("'ai-top-up-checkout:' || \"id\"");
    expect(sql).toContain("TopUpCheckoutAttempt_activeOwnerKey_key");
    expect(sql).toContain("TopUpCheckoutAttempt_checkoutKey_key");
    expect(sql).toContain('"createLeaseToken" STRING');
    expect(sql).toContain('"createLeaseExpiresAt" TIMESTAMP(3)');
    expect(sql).toContain("TopUpCheckoutAttempt_create_lease_pair_check");
    expect(sql).toContain("TopUpCheckoutAttempt_unbound_recovery_idx");
    expect(sql).toContain("HAVING count(*) = 1");
    expect(sql).toContain("'expired'");
  });

  it("keeps intervention evidence for periodic canonical Stripe rechecks", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain('"interventionAt" TIMESTAMP(3)');
    expect(sql).toContain('"lastCanonicalCheckAt" TIMESTAMP(3)');
    expect(sql).toContain("TopUpDuplicateRefundAttempt_due_idx");
    expect(sql).toContain('"canonicalPaymentIntentId" STRING');
    expect(sql.indexOf('"interventionAt"')).toBeGreaterThan(
      sql.indexOf('TopUpDuplicateRefundAttempt" SET (schema_locked = false)'),
    );
  });
});
