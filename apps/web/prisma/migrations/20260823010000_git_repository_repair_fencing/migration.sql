-- 掴んでいる実行を指す印と、人の確認待ちの目印。
-- 期限だけでは、期限切れで引き取られた側が譲渡や控えの削除を続けられる。
ALTER TABLE "GitRepositoryRepair" ADD COLUMN IF NOT EXISTS "intentId" STRING;
ALTER TABLE "GitRepositoryRepair" ADD COLUMN IF NOT EXISTS "needsReview" BOOL NOT NULL DEFAULT false;
