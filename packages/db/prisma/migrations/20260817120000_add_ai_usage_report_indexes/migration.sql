-- 管理画面の AI 利用状況レポート用のインデックス。
-- 期間で絞ってから status / kind / userId で集約するため、これが無いと
-- 表示のたびに AiJob と CreditTransaction の全体スキャンが走る。
-- どちらのテーブルも schema_locked のため、変更の前後で解除と再ロックを行う。
ALTER TABLE "AiJob" SET (schema_locked = false);

-- CreateIndex
CREATE INDEX "AiJob_createdAt_idx" ON "AiJob"("createdAt" DESC);

ALTER TABLE "AiJob" SET (schema_locked = true);

ALTER TABLE "CreditTransaction" SET (schema_locked = false);

-- CreateIndex
CREATE INDEX "CreditTransaction_kind_createdAt_idx" ON "CreditTransaction"("kind", "createdAt" DESC);

ALTER TABLE "CreditTransaction" SET (schema_locked = true);
