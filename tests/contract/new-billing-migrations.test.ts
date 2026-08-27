import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrations = [
  "20260825000000_add_ai_storage_cleanup_upload_id/migration.sql",
  "20260825123000_add_package_checkout_attempt/migration.sql",
  "20260825130000_add_package_payment_refund_attempt/migration.sql",
  "20260825133000_add_stripe_customer_provisioning/migration.sql",
  "20260825134500_add_stripe_checkout_cleanup/migration.sql",
  "20260825140000_detach_checkout_attempts/migration.sql",
  "20260825140000_add_ai_storage_cleanup_lease_token/migration.sql",
  "20260825151000_add_topup_checkout_recovery/migration.sql",
  "20260825180000_repair_package_checkout_recovery_not_before/migration.sql",
  "20260825190000_add_package_checkout_discovery_token/migration.sql",
  "20260825200000_add_package_checkout_create_lease/migration.sql",
  "20260825210000_add_package_checkout_resolution/migration.sql",
  "20260825220000_add_topup_duplicate_refund_attempt/migration.sql",
  "20260825230000_add_topup_checkout_resolution/migration.sql",
  "20260826050000_harden_topup_checkout_recovery/migration.sql",
  "20260827000000_split_storage_multipart_cleanup/migration.sql",
  "20260827010000_harden_storage_multipart_cleanup/migration.sql",
  "20260827020000_harden_topup_intervention_audit/migration.sql",
  "20260827030000_add_storage_upload_completion_lease/migration.sql",
];

describe("new billing migrations", () => {
  it("keeps the Wrangler lifecycle config in the lowercase rules shape", async () => {
    const lifecycle = JSON.parse(await readFile(new URL("../../apps/web/r2-lifecycle.json", import.meta.url), "utf8")) as { rules?: Array<Record<string, unknown>> };
    expect(Array.isArray(lifecycle.rules)).toBe(true);
    expect(lifecycle.rules).toHaveLength(1);
    expect(lifecycle.rules?.[0]).toMatchObject({ id: "abort-incomplete-multipart-uploads", enabled: true, conditions: {}, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * 24 * 60 * 60 } } });
  });
  it.each(migrations)("uses Cockroach schema unlock/relock for %s", async (relativePath) => {
    const sql = await readFile(new URL(`../../apps/web/prisma/migrations/${relativePath}`, import.meta.url), "utf8");
    const unlock = sql.indexOf("schema_locked = false");
    const relock = sql.lastIndexOf("schema_locked = true");
    expect(unlock).toBeGreaterThanOrEqual(0);
    expect(relock).toBeGreaterThan(unlock);
    if (sql.includes("CREATE INDEX")) {
      expect(sql.indexOf("CREATE INDEX")).toBeGreaterThan(unlock);
    }
  });

  it("detaches checkout attempts before cascade deletion and keeps package attempts user-independent", async () => {
    const packageSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825123000_add_package_checkout_attempt/migration.sql", import.meta.url), "utf8");
    const detachSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825140000_detach_checkout_attempts/migration.sql", import.meta.url), "utf8");
    expect(packageSql).not.toContain("PackageCheckoutAttempt_userId_fkey");
    expect(detachSql).toContain("ProCheckoutAttempt_userId_fkey");
    expect(detachSql).toContain("DROP CONSTRAINT IF EXISTS");
    expect(detachSql).not.toContain('ALTER COLUMN "customerId" SET NOT NULL');
    expect(detachSql).toContain('bound Session without a Customer mapping');
    expect(detachSql).toContain('unbound legacy row without paramsJson');
    expect(detachSql).toContain('WHERE "stripeCheckoutSessionId" IS NULL AND "paramsJson" IS NULL');
    expect(detachSql).not.toContain('WHERE "accountDeletionAt" IS NOT NULL AND "stripeCheckoutSessionId" IS NULL AND "paramsJson" IS NULL');
    expect(detachSql).not.toContain('force_panic');
    expect(detachSql.indexOf('RAISE EXCEPTION')).toBeLessThan(detachSql.indexOf('DROP CONSTRAINT IF EXISTS'));
    expect(detachSql.indexOf("DROP CONSTRAINT IF EXISTS")).toBeGreaterThanOrEqual(0);
    expect(packageSql).toContain('"customerId" STRING NOT NULL');
    const tokenSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825190000_add_package_checkout_discovery_token/migration.sql", import.meta.url), "utf8");
    expect(tokenSql).toContain('"discoveryToken"');
    const leaseSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825200000_add_package_checkout_create_lease/migration.sql", import.meta.url), "utf8");
    expect(leaseSql).toContain('"createLeaseToken" STRING');
    expect(leaseSql).toContain('create_lease_pair_check');
    expect(tokenSql).toContain('DEFAULT gen_random_uuid()::STRING');
    expect(tokenSql).toContain('ADD COLUMN IF NOT EXISTS "discoveryToken" STRING DEFAULT');
    expect(tokenSql).toContain('PackageCheckoutAttempt_discoveryToken_key');
    expect(packageSql).toContain('"paramsJson" STRING NOT NULL');
    expect(packageSql).toContain("recovery_idx");
    expect(packageSql).toContain("recovery_lease_pair_check");
    expect(packageSql).toContain('"recoveryLeaseToken" IS NULL AND "recoveryLeaseExpiresAt" IS NULL');
    const repairSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825180000_repair_package_checkout_recovery_not_before/migration.sql", import.meta.url), "utf8");
    expect(repairSql).toContain("recoveryNotBefore");
    expect(repairSql).toContain("Forward-only repair");
    expect(repairSql).toContain("ADD COLUMN IF NOT EXISTS");
    expect(repairSql).toContain('"PackageCheckoutAttempt_recovery_idx" ON "PackageCheckoutAttempt" ("status", "accountDeletionAt", "recoveryNotBefore", "recoveryLeaseExpiresAt")');
    const schema = await readFile(new URL("../../apps/web/prisma/schema.prisma", import.meta.url), "utf8");
    const packageModel = schema.slice(schema.indexOf("model PackageCheckoutAttempt"), schema.indexOf("model PackagePaymentRefundAttempt"));
    expect(packageModel).toContain("recoveryNotBefore     DateTime?");
    expect(packageModel).toMatch(/@@index\(\[status, accountDeletionAt, recoveryNotBefore, recoveryLeaseExpiresAt, createLeaseExpiresAt\](?:, map: "PackageCheckoutAttempt_recovery_idx")?\)/);
    expect(detachSql).toContain("recovery_lease_pair_check");
    expect(detachSql).toContain("recoveryAttempts");
    const topUpSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825151000_add_topup_checkout_recovery/migration.sql", import.meta.url), "utf8");
    expect(topUpSql).toContain("recoveryNotBefore");
    expect(topUpSql).toContain("recoveryInterventionAt");
    expect(topUpSql).toContain("recovery_lease_pair_check");
    expect(topUpSql).toContain("Legacy top-up attempt has no durable params");
    const topUpResolutionSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825230000_add_topup_checkout_resolution/migration.sql", import.meta.url), "utf8");
    expect((topUpResolutionSql.match(/"revision" INT4/g) ?? []).length).toBe(2);
    expect(topUpResolutionSql).toContain(
      'ADD COLUMN IF NOT EXISTS "revision" INT4',
    );
    expect(topUpResolutionSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    const receiptSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825170000_retain_storage_upload_receipts/migration.sql", import.meta.url), "utf8");
    expect(receiptSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    const uploadSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825000000_add_ai_storage_cleanup_upload_id/migration.sql", import.meta.url), "utf8");
    expect(uploadSql).toContain("uploadId");
    const storageLeaseSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825140000_add_ai_storage_cleanup_lease_token/migration.sql", import.meta.url), "utf8");
    expect(storageLeaseSql).toContain("leaseToken");
    const multipartCleanupSql = await readFile(new URL("../../apps/web/prisma/migrations/20260827000000_split_storage_multipart_cleanup/migration.sql", import.meta.url), "utf8");
    expect(multipartCleanupSql).toContain('CREATE TABLE IF NOT EXISTS "StorageMultipartCleanup"');
    expect(multipartCleanupSql).toContain('PRIMARY KEY ("objectKey", "uploadId")');
    expect(multipartCleanupSql).toContain('FROM "AiStorageCleanup"');
    expect(multipartCleanupSql).toContain('FROM "StorageUpload"');
    expect(multipartCleanupSql).toContain('AiStorageCleanup_uploadId_retired_ck');
    expect(multipartCleanupSql).toContain('SET "uploadId" = NULL');
    expect(multipartCleanupSql).toContain('"cleanupLeaseToken" STRING');
    expect(multipartCleanupSql).toContain('StorageUpload_cleanupLease_pair_ck');
    expect(multipartCleanupSql).toContain('StorageUpload_abandonedAt_cleanupLeaseUntil_idx');
    const multipartHardeningSql = await readFile(new URL("../../apps/web/prisma/migrations/20260827010000_harden_storage_multipart_cleanup/migration.sql", import.meta.url), "utf8");
    expect(multipartHardeningSql).toContain('operatorReason');
    expect(multipartHardeningSql).toContain('terminalizedAt');
    expect(multipartHardeningSql).toContain('"attempts" INT4');
    expect(multipartHardeningSql).toContain('"revision" INT4');
    expect(multipartHardeningSql).toContain('StorageMultipartCleanup_status_notBefore_idx');
    const completionLeaseSql = await readFile(new URL("../../apps/web/prisma/migrations/20260827030000_add_storage_upload_completion_lease/migration.sql", import.meta.url), "utf8");
    expect(completionLeaseSql).toContain('"completionState" STRING NOT NULL DEFAULT \'idle\'');
    expect(completionLeaseSql).toContain('StorageUpload_completionLease_pair_ck');
    expect(completionLeaseSql).toContain('StorageUpload_completionState_ck');
    expect(completionLeaseSql).toContain('StorageUpload_completionState_completionLeaseUntil_idx');
    expect(completionLeaseSql).toContain('completionRetryNotBefore');
    expect(completionLeaseSql).toContain('StorageUpload_completionRetryNotBefore_ck');
    expect(completionLeaseSql).toContain("'resumed'");
    expect(completionLeaseSql).toContain('StorageUpload_completionState_completionRetryNotBefore_idx');
    expect(completionLeaseSql).toContain('DROP CONSTRAINT IF EXISTS "StorageUpload_completionState_ck"');
    expect(completionLeaseSql.indexOf('DROP INDEX IF EXISTS "StorageUpload_completionState_completionLeaseUntil_idx"')).toBeLessThan(completionLeaseSql.indexOf('CREATE INDEX IF NOT EXISTS "StorageUpload_completionState_completionLeaseUntil_idx"'));
    expect(schema).toContain('completionRetryNotBefore DateTime?');
    const resolutionSql = await readFile(new URL("../../apps/web/prisma/migrations/20260825210000_add_package_checkout_resolution/migration.sql", import.meta.url), "utf8");
    expect(resolutionSql).toContain("PackageCheckoutResolution_status_check");
    expect(resolutionSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(resolutionSql).toContain("canonicalPaymentIntentId");
    expect(resolutionSql).toContain("expectedRefundPaymentIntentIds");
    for (const [file, name] of [
      ["20260825130000_add_package_payment_refund_attempt/migration.sql", "PackagePaymentRefundAttempt"],
      ["20260825133000_add_stripe_customer_provisioning/migration.sql", "StripeCustomerProvisioning"],
      ["20260825134500_add_stripe_checkout_cleanup/migration.sql", "StripeCheckoutCleanup"],
    ] as const) {
      const sql = await readFile(new URL(`../../apps/web/prisma/migrations/${file}`, import.meta.url), "utf8");
      expect(sql).toContain(`${name}_attempts_check`);
      expect(sql).toContain(`${name}_lease_pair_check`);
    }
  });

  it("backfills every legacy top-up intervention marker into an auditable resolution", async () => {
    const sql = await readFile(new URL("../../apps/web/prisma/migrations/20260827020000_harden_topup_intervention_audit/migration.sql", import.meta.url), "utf8");
    expect(sql).toContain('a."recoveryInterventionAt" IS NOT NULL');
    expect(sql).toContain('LEFT JOIN "TopUpCheckoutResolution"');
    expect(sql).toContain("expectedPaymentIntentIds");
    expect(sql).toContain('a."stripePaymentIntentId", \'[]\'');
    expect(sql).toContain("'intervention'");
    expect(sql).toContain("TopUpDuplicateRefundAttempt_refunded_amount_check");
    expect(sql).toContain('"refundedAmount" <> "amount"');
    expect(sql).toContain("TopUpCheckoutAttempt_refunded_amount_check");
    expect(sql).toContain('"status" = \'refund_failed\'');
    expect(sql).toContain('"operatorLeaseToken" STRING');
    expect(sql).toContain('"operatorLeaseExpiresAt" TIMESTAMP(3)');
    expect(sql).toContain('"operatorAbsenceObservedAt" TIMESTAMP(3)');
    expect(sql).toContain("TopUpCheckoutResolution_operator_lease_pair_check");
  });
});
