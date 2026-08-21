-- 進行中の退会処理に期限を持たせる。
-- 期限が切れていれば、その処理はもう居ないものとして他の要求が引き取れる。
-- 既存行 (あれば) は NULL のまま = 期限切れ扱いになり、すぐ引き取れる。
ALTER TABLE "GitAccountDeletion" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
