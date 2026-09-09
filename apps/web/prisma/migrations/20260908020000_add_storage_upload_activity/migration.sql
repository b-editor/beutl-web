-- 放置アップロードの判定を「開始からの経過時間」から「最後の活動からの経過時間」に
-- 変える。パートが届くたびに lastActivityAt を更新し、24 時間パートが来ない
-- アップロードだけを掃除する。NULL は一度もパートが届いていない行で、その場合は
-- createdAt を起点にする (既存行はそのまま NULL でよい)。
-- 追加のみ・再実行可能・メンテナンス窓不要。
ALTER TABLE "StorageUpload" SET (schema_locked = false);
ALTER TABLE "StorageUpload" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "StorageUpload_completedFileId_lastActivityAt_idx"
    ON "StorageUpload"("completedFileId", "lastActivityAt");
ALTER TABLE "StorageUpload" SET (schema_locked = true);
