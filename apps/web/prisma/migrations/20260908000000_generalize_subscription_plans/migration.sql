-- サブスクリプションを「ユーザー × プラン」で持てるようにし、プラン内の段階 (tier)
-- を契約・チェックアウト試行・offer に持たせる。AI Pro とストレージプランが同じ
-- テーブルと同じ経路を使い、将来 AI にティアを増やすときも列は増えない。
--
-- 主キーの変更は既存の行をそのまま保つ (既存行は planId = 'pro' で一意)。
-- 旧ランタイムは userId 単独で upsert するため、このマイグレーションと新しい
-- ランタイムの間は短く保つ (docs/stripe-ai-billing-migration.md)。
-- 前進のみ・再実行可能に書く。

-- 1. Subscription: 複合主キー + tier
ALTER TABLE "Subscription" SET (schema_locked = false);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "tier" STRING;
ALTER TABLE "Subscription" ALTER PRIMARY KEY USING COLUMNS ("userId", "planId");
-- 旧主キーは userId 単独の二次索引として残るので落とす。
DROP INDEX IF EXISTS "Subscription_userId_key" CASCADE;

-- 2. ProCheckoutAttempt -> SubscriptionCheckoutAttempt: planId / tier + 複合主キー
ALTER TABLE "ProCheckoutAttempt" SET (schema_locked = false);
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "planId" STRING NOT NULL DEFAULT 'pro';
ALTER TABLE "ProCheckoutAttempt" ADD COLUMN IF NOT EXISTS "tier" STRING;
ALTER TABLE "ProCheckoutAttempt" ALTER PRIMARY KEY USING COLUMNS ("userId", "planId");
DROP INDEX IF EXISTS "ProCheckoutAttempt_userId_key" CASCADE;
ALTER TABLE IF EXISTS "ProCheckoutAttempt" RENAME TO "SubscriptionCheckoutAttempt";
-- 索引と制約の名前は旧名のまま (schema.prisma が map で参照する)。

-- 3. BillingOffer: ティア列と、プランごとの条件を通す CHECK
ALTER TABLE "BillingOffer" SET (schema_locked = false);
ALTER TABLE "BillingOffer" ADD COLUMN IF NOT EXISTS "tier" STRING;
ALTER TABLE "BillingOffer" DROP CONSTRAINT IF EXISTS "BillingOffer_kind_check";
ALTER TABLE "BillingOffer" ADD CONSTRAINT IF NOT EXISTS "BillingOffer_kind_check"
    CHECK ("kind" IN ('pro', 'top_up', 'storage'));
-- ティアの集合はコード (packages/core) が検証する。ここではプランの形だけ縛る。
ALTER TABLE "BillingOffer" DROP CONSTRAINT IF EXISTS "BillingOffer_terms_check";
ALTER TABLE "BillingOffer" ADD CONSTRAINT IF NOT EXISTS "BillingOffer_terms_check"
    CHECK (
        ("kind" IN ('pro', 'storage')
         AND "creditAmount" IS NULL
         AND "recurringInterval" IS NOT NULL
         AND "recurringInterval" = 'month'
         AND "recurringIntervalCount" IS NOT NULL
         AND "recurringIntervalCount" = 1)
        OR
        ("kind" = 'top_up'
         AND "tier" IS NULL
         AND "creditAmount" IS NOT NULL
         AND "creditAmount" > 0
         AND "recurringInterval" IS NULL
         AND "recurringIntervalCount" IS NULL)
    );
CREATE INDEX IF NOT EXISTS "BillingOffer_kind_tier_checkoutEnabled_idx"
    ON "BillingOffer"("kind", "tier", "checkoutEnabled");

ALTER TABLE "Subscription" SET (schema_locked = true);
ALTER TABLE "SubscriptionCheckoutAttempt" SET (schema_locked = true);
ALTER TABLE "BillingOffer" SET (schema_locked = true);
