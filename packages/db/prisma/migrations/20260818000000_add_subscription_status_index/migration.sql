-- 管理画面の AI 利用状況レポートが有効な Pro 契約数を数えるためのインデックス。
-- status と currentPeriodEnd のどちらにも索引が無く、レポートを開くたび、また
-- 期間フィルタを変えるたびに Subscription の全体スキャンが走っていた。
-- このテーブルも schema_locked のため、変更の前後で解除と再ロックを行う。
ALTER TABLE "Subscription" SET (schema_locked = false);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Subscription_status_currentPeriodEnd_idx"
ON "Subscription"("status", "currentPeriodEnd");

ALTER TABLE "Subscription" SET (schema_locked = true);
