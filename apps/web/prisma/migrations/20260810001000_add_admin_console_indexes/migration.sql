-- 管理画面 (apps/admin) の一覧クエリ用のインデックス。
-- Feedback / AuditLog はどちらも createdAt 降順で並べ、絞り込み列を伴う。
-- これが無いと一覧表示のたびにテーブル全体のスキャンとソートが走る。

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Feedback_category_createdAt_idx" ON "Feedback"("category", "createdAt" DESC);
