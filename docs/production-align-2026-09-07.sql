-- Align production with prisma/migrations (generated 2026-09-07 from the replayed history).
-- One statement per line; each statement is idempotent or a no-op on rerun.
-- Every table is unlocked for its block and returned to the lock state it had in production.

-- ==== AiJob (production schema_locked=true) ====
ALTER TABLE "AiJob" SET (schema_locked = false);
ALTER TABLE "AiJob" ALTER COLUMN "usageUnits" TYPE INT8;
ALTER TABLE "AiJob" ADD CONSTRAINT IF NOT EXISTS "AiJob_callbackNonceHash_length_check" CHECK ((("callbackNonceHash" IS NULL) OR (length("callbackNonceHash") = 64)));
ALTER TABLE "AiJob" ADD CONSTRAINT IF NOT EXISTS "AiJob_idempotencyKeyHash_length_check" CHECK ((("idempotencyKeyHash" IS NULL) OR (length("idempotencyKeyHash") = 64)));
ALTER TABLE "AiJob" ADD CONSTRAINT IF NOT EXISTS "AiJob_idempotency_pair_check" CHECK (((("idempotencyKeyHash" IS NULL) AND ("requestFingerprint" IS NULL)) OR (("idempotencyKeyHash" IS NOT NULL) AND ("requestFingerprint" IS NOT NULL))));
ALTER TABLE "AiJob" ADD CONSTRAINT IF NOT EXISTS "AiJob_requestFingerprint_length_check" CHECK ((("requestFingerprint" IS NULL) OR (length("requestFingerprint") = 64)));
ALTER TABLE "AiJob" SET (schema_locked = true);

-- ==== AiStorageCleanup (production schema_locked=true) ====
ALTER TABLE "AiStorageCleanup" SET (schema_locked = false);
ALTER TABLE "AiStorageCleanup" ADD COLUMN IF NOT EXISTS "uploadId" STRING;
ALTER TABLE "AiStorageCleanup" ADD CONSTRAINT IF NOT EXISTS "AiStorageCleanup_state_check" CHECK ((state IN ('writing'::STRING, 'cleanup'::STRING)));
ALTER TABLE "AiStorageCleanup" ADD CONSTRAINT IF NOT EXISTS "AiStorageCleanup_uploadId_retired_ck" CHECK (("uploadId" IS NULL));
ALTER TABLE "AiStorageCleanup" SET (schema_locked = true);

-- ==== BillingOffer (production schema_locked=true) ====
ALTER TABLE "BillingOffer" SET (schema_locked = false);
ALTER TABLE "BillingOffer" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::STRING;
ALTER TABLE "BillingOffer" ADD CONSTRAINT IF NOT EXISTS "BillingOffer_kind_check" CHECK ((kind IN ('pro'::STRING, 'top_up'::STRING)));
ALTER TABLE "BillingOffer" ADD CONSTRAINT IF NOT EXISTS "BillingOffer_terms_check" CHECK ((((((((kind = 'pro'::STRING) AND ("creditAmount" IS NULL)) AND ("recurringInterval" IS NOT NULL)) AND ("recurringInterval" = 'month'::STRING)) AND ("recurringIntervalCount" IS NOT NULL)) AND ("recurringIntervalCount" = 1)) OR (((((kind = 'top_up'::STRING) AND ("creditAmount" IS NOT NULL)) AND ("creditAmount" > 0)) AND ("recurringInterval" IS NULL)) AND ("recurringIntervalCount" IS NULL))));
ALTER TABLE "BillingOffer" ADD CONSTRAINT IF NOT EXISTS "BillingOffer_unitAmount_check" CHECK (("unitAmount" > 0));
ALTER TABLE "BillingOffer" SET (schema_locked = true);

-- ==== BillingRefundAttempt (production schema_locked=true) ====
ALTER TABLE "BillingRefundAttempt" SET (schema_locked = false);
ALTER TABLE "BillingRefundAttempt" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::STRING;
ALTER TABLE "BillingRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "BillingRefundAttempt_amounts_check" CHECK ((((("targetAmount" IS NULL) OR ("targetAmount" >= 0)) AND ("succeededAmount" >= 0)) AND ("pendingAmount" >= 0)));
ALTER TABLE "BillingRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "BillingRefundAttempt_attempts_check" CHECK ((attempts >= 0));
ALTER TABLE "BillingRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "BillingRefundAttempt_lease_pair_check" CHECK (((("leaseToken" IS NULL) AND ("leaseExpiresAt" IS NULL)) OR (("leaseToken" IS NOT NULL) AND ("leaseExpiresAt" IS NOT NULL))));
ALTER TABLE "BillingRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "BillingRefundAttempt_status_check" CHECK ((status IN ('required'::STRING, 'refund_pending'::STRING, 'refunded'::STRING, 'no_refund_required'::STRING, 'intervention_required'::STRING)));
ALTER TABLE "BillingRefundAttempt" SET (schema_locked = true);

-- ==== CreditAccount (production schema_locked=true) ====
ALTER TABLE "CreditAccount" SET (schema_locked = false);
ALTER TABLE "CreditAccount" ALTER COLUMN "monthlyUsageUsed" TYPE INT8;
ALTER TABLE "CreditAccount" ALTER COLUMN "purchasedCredits" TYPE INT8;
ALTER TABLE "CreditAccount" ALTER COLUMN "purchasedCreditDebt" TYPE INT8;
ALTER TABLE "CreditAccount" ADD CONSTRAINT IF NOT EXISTS "CreditAccount_purchasedCreditDebt_nonnegative" CHECK (("purchasedCreditDebt" >= 0));
ALTER TABLE "CreditAccount" ADD CONSTRAINT IF NOT EXISTS "CreditAccount_purchasedCredits_nonnegative" CHECK (("purchasedCredits" >= 0));
ALTER TABLE "CreditAccount" SET (schema_locked = true);

-- ==== CreditTransaction (production schema_locked=true) ====
ALTER TABLE "CreditTransaction" SET (schema_locked = false);
ALTER TABLE "CreditTransaction" ALTER COLUMN "creditAmount" TYPE INT8;
ALTER TABLE "CreditTransaction" ALTER COLUMN "debtAmount" TYPE INT8;
ALTER TABLE "CreditTransaction" ALTER COLUMN "usageAmount" TYPE INT8;
ALTER TABLE "CreditTransaction" ALTER COLUMN "stripePaymentAmount" TYPE INT8;
ALTER TABLE "CreditTransaction" ALTER COLUMN "stripeReversalRevision" TYPE INT8;
ALTER INDEX IF EXISTS "CreditTransaction_stripeReversalKind_stripeReversalId_strip_key" RENAME TO "CreditTransaction_stripeReversalKind_stripeReversalId_stripeReversalRevision_key";
ALTER TABLE "CreditTransaction" DROP CONSTRAINT IF EXISTS "CreditTransaction_billingOfferId_fkey";
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_billingOfferId_fkey" FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditTransaction" SET (schema_locked = true);

-- ==== PackageCheckoutAttempt (production schema_locked=true) ====
ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "PackageCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutAttempt_create_lease_pair_check" CHECK (((("createLeaseToken" IS NULL) AND ("createLeaseExpiresAt" IS NULL)) OR (("createLeaseToken" IS NOT NULL) AND ("createLeaseExpiresAt" IS NOT NULL))));
ALTER TABLE "PackageCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutAttempt_recovery_lease_pair_check" CHECK (((("recoveryLeaseToken" IS NULL) AND ("recoveryLeaseExpiresAt" IS NULL)) OR (("recoveryLeaseToken" IS NOT NULL) AND ("recoveryLeaseExpiresAt" IS NOT NULL))));
ALTER TABLE "PackageCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutAttempt_status_check" CHECK ((status IN ('open'::STRING, 'recovering'::STRING, 'terminal'::STRING, 'intervention'::STRING)));
ALTER TABLE "PackageCheckoutAttempt" SET (schema_locked = true);

-- ==== PackageCheckoutResolution (production schema_locked=true) ====
ALTER TABLE "PackageCheckoutResolution" SET (schema_locked = false);
ALTER TABLE "PackageCheckoutResolution" ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutResolution_revision_check" CHECK ((revision >= 0));
ALTER TABLE "PackageCheckoutResolution" ADD CONSTRAINT IF NOT EXISTS "PackageCheckoutResolution_status_check" CHECK ((status IN ('intervention'::STRING, 'refund_pending'::STRING, 'resolved'::STRING, 'terminal'::STRING)));
ALTER TABLE "PackageCheckoutResolution" SET (schema_locked = true);

-- ==== PackagePaymentRefundAttempt (production schema_locked=true) ====
ALTER TABLE "PackagePaymentRefundAttempt" SET (schema_locked = false);
ALTER TABLE "PackagePaymentRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "PackagePaymentRefundAttempt_attempts_check" CHECK ((attempts >= 0));
ALTER TABLE "PackagePaymentRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "PackagePaymentRefundAttempt_lease_pair_check" CHECK (((("leaseToken" IS NULL) AND ("leaseExpiresAt" IS NULL)) OR (("leaseToken" IS NOT NULL) AND ("leaseExpiresAt" IS NOT NULL))));
ALTER TABLE "PackagePaymentRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "PackagePaymentRefundAttempt_status_check" CHECK ((status IN ('required'::STRING, 'retry'::STRING, 'refunded'::STRING, 'intervention'::STRING)));
ALTER TABLE "PackagePaymentRefundAttempt" SET (schema_locked = true);

-- ==== PackagePricing (production schema_locked=false) ====
ALTER TABLE "PackagePricing" ALTER COLUMN "price" TYPE INT8;

-- ==== PackageScreenshot (production schema_locked=false) ====
ALTER TABLE "PackageScreenshot" ALTER COLUMN "order" TYPE INT8;

-- ==== ProCheckoutAttempt (production schema_locked=true) ====
ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "ProCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "ProCheckoutAttempt_recovery_attempts_check" CHECK (("recoveryAttempts" >= 0));
ALTER TABLE "ProCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "ProCheckoutAttempt_recovery_lease_pair_check" CHECK (((("recoveryLeaseToken" IS NULL) AND ("recoveryLeaseExpiresAt" IS NULL)) OR (("recoveryLeaseToken" IS NOT NULL) AND ("recoveryLeaseExpiresAt" IS NOT NULL))));
ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = true);

-- ==== StorageFolder (production schema_locked=false) ====
ALTER TABLE "StorageFolder" ADD CONSTRAINT IF NOT EXISTS "StorageFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "StorageFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==== StorageMultipartCleanup (production schema_locked=true) ====
ALTER TABLE "StorageMultipartCleanup" SET (schema_locked = false);
ALTER TABLE "StorageMultipartCleanup" ADD CONSTRAINT IF NOT EXISTS "StorageMultipartCleanup_status_ck" CHECK ((status IN ('pending'::STRING, 'processing'::STRING, 'retry'::STRING, 'intervention'::STRING, 'terminal'::STRING)));
ALTER TABLE "StorageMultipartCleanup" SET (schema_locked = true);

-- ==== StorageUpload (production schema_locked=true) ====
ALTER TABLE "StorageUpload" SET (schema_locked = false);
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_cleanupLease_pair_ck" CHECK (((("cleanupLeaseToken" IS NULL) AND ("cleanupLeaseUntil" IS NULL)) OR ((("cleanupLeaseToken" IS NOT NULL) AND ("cleanupLeaseUntil" IS NOT NULL)) AND ("abandonedAt" IS NOT NULL))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionAttempts_ck" CHECK (("completionAttempts" >= 0));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionIntervention_ck" CHECK (((("reservationKind" = 'multipart'::STRING) AND ((("completionState" IN ('intervention'::STRING, 'unknown'::STRING)) AND ("completionInterventionAt" IS NOT NULL)) OR (("completionState" NOT IN ('intervention'::STRING, 'unknown'::STRING)) AND ("completionInterventionAt" IS NULL)))) OR (("reservationKind" = 'dedicated'::STRING) AND ((("completionState" = 'unknown'::STRING) AND ("completionInterventionAt" IS NOT NULL)) OR (("completionState" != 'unknown'::STRING) AND ("completionInterventionAt" IS NULL))))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionLease_pair_ck" CHECK (((("reservationKind" = 'multipart'::STRING) AND ((((("completionState" = 'idle'::STRING) AND ("completionLeaseToken" IS NULL)) AND ("completionLeaseUntil" IS NULL)) OR ((("completionState" = 'completing'::STRING) AND ("completionLeaseToken" IS NOT NULL)) AND ("completionLeaseUntil" IS NOT NULL))) OR ((("completionState" IN ('retry'::STRING, 'resumed'::STRING, 'settled'::STRING, 'intervention'::STRING, 'unknown'::STRING)) AND ("completionLeaseToken" IS NULL)) AND ("completionLeaseUntil" IS NULL)))) OR (("reservationKind" = 'dedicated'::STRING) AND (((("completionState" = 'completing'::STRING) AND ("completionLeaseToken" IS NOT NULL)) AND ("completionLeaseUntil" IS NOT NULL)) OR ((("completionState" IN ('idle'::STRING, 'settled'::STRING, 'unknown'::STRING)) AND ("completionLeaseToken" IS NULL)) AND ("completionLeaseUntil" IS NULL))))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionRetryNotBefore_ck" CHECK (((("completionState" IN ('retry'::STRING, 'resumed'::STRING)) AND ("completionRetryNotBefore" IS NOT NULL)) OR (("completionState" NOT IN ('retry'::STRING, 'resumed'::STRING)) AND ("completionRetryNotBefore" IS NULL))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionRevision_ck" CHECK (("completionRevision" >= 0));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_completionState_ck" CHECK (("completionState" IN ('idle'::STRING, 'retry'::STRING, 'resumed'::STRING, 'completing'::STRING, 'settled'::STRING, 'intervention'::STRING, 'unknown'::STRING)));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_creationLease_ck" CHECK (((("reservationKind" = 'multipart'::STRING) AND (((("startState" = 'creating'::STRING) AND ("creationLeaseUntil" IS NOT NULL)) AND ("creationLeaseToken" IS NOT NULL)) OR ((("startState" != 'creating'::STRING) AND ("creationLeaseUntil" IS NULL)) AND ("creationLeaseToken" IS NULL)))) OR ((("reservationKind" = 'dedicated'::STRING) AND ("startState" = 'dedicated'::STRING)) AND ((((("completedFileId" IS NULL) AND ("abandonedAt" IS NULL)) AND ("creationLeaseUntil" IS NOT NULL)) AND ("creationLeaseToken" IS NOT NULL)) OR (((("completedFileId" IS NOT NULL) OR ("abandonedAt" IS NOT NULL)) AND ("creationLeaseUntil" IS NULL)) AND ("creationLeaseToken" IS NULL))))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_reservationKind_ck" CHECK (("reservationKind" IN ('multipart'::STRING, 'dedicated'::STRING)));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_startState_ck" CHECK (("startState" IN ('intent'::STRING, 'creating'::STRING, 'active'::STRING, 'dedicated'::STRING)));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_startState_uploadId_ck" CHECK ((((("reservationKind" = 'dedicated'::STRING) AND ("startState" = 'dedicated'::STRING)) AND ("uploadId" IS NULL)) OR (("reservationKind" = 'multipart'::STRING) AND ((("startState" IN ('intent'::STRING, 'creating'::STRING)) AND ("uploadId" IS NULL)) OR (("startState" = 'active'::STRING) AND ("uploadId" IS NOT NULL))))));
ALTER TABLE "StorageUpload" ADD CONSTRAINT IF NOT EXISTS "StorageUpload_unknownProbeLease_pair_ck" CHECK (((("completionState" = 'unknown'::STRING) AND ((("unknownProbeLeaseToken" IS NULL) AND ("unknownProbeNotBefore" IS NULL)) OR (("unknownProbeLeaseToken" IS NOT NULL) AND ("unknownProbeNotBefore" IS NOT NULL)))) OR ((("completionState" != 'unknown'::STRING) AND ("unknownProbeLeaseToken" IS NULL)) AND ("unknownProbeNotBefore" IS NULL))));
ALTER TABLE "StorageUpload" SET (schema_locked = true);

-- ==== StripeCheckoutCleanup (production schema_locked=true) ====
ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = false);
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT IF NOT EXISTS "StripeCheckoutCleanup_attempts_check" CHECK ((attempts >= 0));
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT IF NOT EXISTS "StripeCheckoutCleanup_kind_check" CHECK ((kind IN ('package'::STRING, 'pro'::STRING)));
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT IF NOT EXISTS "StripeCheckoutCleanup_lease_pair_check" CHECK (((("leaseToken" IS NULL) AND ("leaseExpiresAt" IS NULL)) OR (("leaseToken" IS NOT NULL) AND ("leaseExpiresAt" IS NOT NULL))));
ALTER TABLE "StripeCheckoutCleanup" ADD CONSTRAINT IF NOT EXISTS "StripeCheckoutCleanup_status_check" CHECK ((status IN ('required'::STRING, 'retry'::STRING, 'completed'::STRING, 'intervention'::STRING)));
ALTER TABLE "StripeCheckoutCleanup" SET (schema_locked = true);

-- ==== StripeCreditReversal (production schema_locked=true) ====
ALTER TABLE "StripeCreditReversal" SET (schema_locked = false);
ALTER TABLE "StripeCreditReversal" ALTER COLUMN "stripeAmount" TYPE INT8;
ALTER TABLE "StripeCreditReversal" ALTER COLUMN "progressionRank" TYPE INT8;
ALTER TABLE "StripeCreditReversal" ALTER COLUMN "revision" TYPE INT8;
ALTER TABLE "StripeCreditReversal" ADD CONSTRAINT IF NOT EXISTS "StripeCreditReversal_amount_positive" CHECK (("stripeAmount" > 0));
ALTER TABLE "StripeCreditReversal" ADD CONSTRAINT IF NOT EXISTS "StripeCreditReversal_revision_positive" CHECK ((revision > 0));
ALTER TABLE "StripeCreditReversal" SET (schema_locked = true);

-- ==== StripeCustomerOwnership (production schema_locked=true) ====
ALTER TABLE "StripeCustomerOwnership" SET (schema_locked = false);
ALTER TABLE "StripeCustomerOwnership" ADD CONSTRAINT IF NOT EXISTS "StripeCustomerOwnership_has_proof_check" CHECK ((("migrationCohort" IS NOT NULL) OR ("verifiedAt" IS NOT NULL)));
ALTER TABLE "StripeCustomerOwnership" SET (schema_locked = true);

-- ==== StripeCustomerProvisioning (production schema_locked=true) ====
ALTER TABLE "StripeCustomerProvisioning" SET (schema_locked = false);
ALTER TABLE "StripeCustomerProvisioning" ADD CONSTRAINT IF NOT EXISTS "StripeCustomerProvisioning_attempts_check" CHECK ((attempts >= 0));
ALTER TABLE "StripeCustomerProvisioning" ADD CONSTRAINT IF NOT EXISTS "StripeCustomerProvisioning_lease_pair_check" CHECK (((("leaseToken" IS NULL) AND ("leaseExpiresAt" IS NULL)) OR (("leaseToken" IS NOT NULL) AND ("leaseExpiresAt" IS NOT NULL))));
ALTER TABLE "StripeCustomerProvisioning" ADD CONSTRAINT IF NOT EXISTS "StripeCustomerProvisioning_status_check" CHECK ((status IN ('pending'::STRING, 'mapping'::STRING, 'cleanup_required'::STRING, 'settled'::STRING, 'cleaned'::STRING, 'intervention'::STRING)));
ALTER TABLE "StripeCustomerProvisioning" SET (schema_locked = true);

-- ==== Subscription (production schema_locked=true) ====
ALTER TABLE "Subscription" SET (schema_locked = false);
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "Subscription_billingOfferId_fkey";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_billingOfferId_fkey" FOREIGN KEY ("billingOfferId") REFERENCES "BillingOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Subscription" SET (schema_locked = true);

-- ==== SubscriptionEntitlementHold (production schema_locked=true) ====
ALTER TABLE "SubscriptionEntitlementHold" SET (schema_locked = false);
ALTER TABLE "SubscriptionEntitlementHold" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::STRING;
ALTER INDEX IF EXISTS "SubscriptionEntitlementHold_stripePaymentIntentId_idx" RENAME TO "SubscriptionEntitlementHold_paymentIntent_idx";
ALTER INDEX IF EXISTS "SubscriptionEntitlementHold_stripeReversalKind_stripeRevers_key" RENAME TO "SubscriptionEntitlementHold_kind_id_key";
ALTER INDEX IF EXISTS "SubscriptionEntitlementHold_userId_stripeSubscriptionId_act_idx" RENAME TO "SubscriptionEntitlementHold_user_subscription_active_idx";
ALTER TABLE "SubscriptionEntitlementHold" ADD CONSTRAINT IF NOT EXISTS "SubscriptionEntitlementHold_active_canonical_check" CHECK (((NOT active) OR ((((((("stripeInvoiceId" IS NOT NULL) AND ("billingPeriodStart" IS NOT NULL)) AND ("billingPeriodEnd" IS NOT NULL)) AND ("paymentAmount" IS NOT NULL)) AND ("reversalAmount" IS NOT NULL)) AND ("reversalAmount" >= "paymentAmount")) AND (currency IS NOT NULL))));
ALTER TABLE "SubscriptionEntitlementHold" ADD CONSTRAINT IF NOT EXISTS "SubscriptionEntitlementHold_amounts_check" CHECK (((("paymentAmount" IS NULL) AND ("reversalAmount" IS NULL)) OR (((("paymentAmount" IS NOT NULL) AND ("paymentAmount" > 0)) AND ("reversalAmount" IS NOT NULL)) AND ("reversalAmount" >= 0))));
ALTER TABLE "SubscriptionEntitlementHold" ADD CONSTRAINT IF NOT EXISTS "SubscriptionEntitlementHold_kind_check" CHECK (("stripeReversalKind" IN ('refund'::STRING, 'dispute'::STRING)));
ALTER TABLE "SubscriptionEntitlementHold" ADD CONSTRAINT IF NOT EXISTS "SubscriptionEntitlementHold_period_check" CHECK (((("billingPeriodStart" IS NULL) AND ("billingPeriodEnd" IS NULL)) OR ((("billingPeriodStart" IS NOT NULL) AND ("billingPeriodEnd" IS NOT NULL)) AND ("billingPeriodStart" < "billingPeriodEnd"))));
ALTER TABLE "SubscriptionEntitlementHold" SET (schema_locked = true);

-- ==== TopUpCheckoutAttempt (production schema_locked=true) ====
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "TopUpCheckoutAttempt" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::STRING;
ALTER INDEX IF EXISTS "TopUpCheckoutAttempt_status_refundNotBefore_refundLeaseExpi_idx" RENAME TO "TopUpCheckoutAttempt_status_refundNotBefore_refundLeaseExpiresAt_idx";
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_create_lease_pair_check" CHECK (((("createLeaseToken" IS NULL) AND ("createLeaseExpiresAt" IS NULL)) OR (("createLeaseToken" IS NOT NULL) AND ("createLeaseExpiresAt" IS NOT NULL))));
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_recovery_attempts_check" CHECK (("recoveryAttempts" >= 0));
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_recovery_lease_pair_check" CHECK (((("recoveryLeaseToken" IS NULL) AND ("recoveryLeaseExpiresAt" IS NULL)) OR (("recoveryLeaseToken" IS NOT NULL) AND ("recoveryLeaseExpiresAt" IS NOT NULL))));
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_refund_amounts_check" CHECK ((((("refundTargetAmount" IS NULL) OR ("refundTargetAmount" >= 0)) AND ("refundSucceededAmount" >= 0)) AND ("refundPendingAmount" >= 0)));
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_refund_attempts_check" CHECK (("refundAttempts" >= 0));
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_refund_lease_pair_check" CHECK (((("refundLeaseToken" IS NULL) AND ("refundLeaseExpiresAt" IS NULL)) OR (("refundLeaseToken" IS NOT NULL) AND ("refundLeaseExpiresAt" IS NOT NULL))));
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_refunded_amount_check" CHECK (((status != 'refunded'::STRING) OR (((("refundTargetAmount" IS NOT NULL) AND ("refundTargetAmount" > 0)) AND ("refundSucceededAmount" = "refundTargetAmount")) AND ("refundPendingAmount" = 0))));
ALTER TABLE "TopUpCheckoutAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutAttempt_status_check" CHECK ((status IN ('open'::STRING, 'payment_pending'::STRING, 'fulfilled'::STRING, 'expired'::STRING, 'refund_required'::STRING, 'refund_pending'::STRING, 'refund_failed'::STRING, 'refunded'::STRING, 'refund_not_required'::STRING)));
ALTER TABLE "TopUpCheckoutAttempt" SET (schema_locked = true);

-- ==== TopUpCheckoutResolution (production schema_locked=true) ====
ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = false);
CREATE INDEX IF NOT EXISTS "TopUpCheckoutResolution_operator_lease_idx" ON "TopUpCheckoutResolution" ("status", "operatorLeaseExpiresAt", "updatedAt");
ALTER TABLE "TopUpCheckoutResolution" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutResolution_operator_lease_pair_check" CHECK (((("operatorLeaseToken" IS NULL) AND ("operatorLeaseExpiresAt" IS NULL)) OR (("operatorLeaseToken" IS NOT NULL) AND ("operatorLeaseExpiresAt" IS NOT NULL))));
ALTER TABLE "TopUpCheckoutResolution" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutResolution_revision_check" CHECK ((revision >= 0));
ALTER TABLE "TopUpCheckoutResolution" ADD CONSTRAINT IF NOT EXISTS "TopUpCheckoutResolution_status_check" CHECK ((status IN ('refund_pending'::STRING, 'intervention'::STRING, 'resolved'::STRING, 'terminal'::STRING)));
ALTER TABLE "TopUpCheckoutResolution" SET (schema_locked = true);

-- ==== TopUpDuplicateRefundAttempt (production schema_locked=true) ====
ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = false);
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_amount_check" CHECK ((((amount > 0) AND ("refundedAmount" >= 0)) AND ("refundedAmount" <= amount)));
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_attempts_check" CHECK ((attempts >= 0));
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_currency_check" CHECK ((length(currency) > 0));
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_lease_pair_check" CHECK (((("leaseToken" IS NULL) AND ("leaseExpiresAt" IS NULL)) OR (("leaseToken" IS NOT NULL) AND ("leaseExpiresAt" IS NOT NULL))));
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_refunded_amount_check" CHECK (((status != 'refunded'::STRING) OR ("refundedAmount" = amount)));
ALTER TABLE "TopUpDuplicateRefundAttempt" ADD CONSTRAINT IF NOT EXISTS "TopUpDuplicateRefundAttempt_status_check" CHECK ((status IN ('required'::STRING, 'processing'::STRING, 'retry'::STRING, 'refunded'::STRING, 'intervention'::STRING)));
ALTER TABLE "TopUpDuplicateRefundAttempt" SET (schema_locked = true);
