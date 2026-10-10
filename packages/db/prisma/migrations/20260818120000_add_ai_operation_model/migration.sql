-- 1 つの操作が選べるモデルとその単価を持つ表。
--
-- AiSetting でも表現できそうに見えるが、あちらのキー集合は
-- packages/core/src/ai-settings.ts の静的なレジストリで、未知のキーは読み出しで
-- 例外になる。管理画面から候補を増やせる一覧はそこには置けない。
--
-- 行が 1 つも無い操作は組み込みの既定にフォールバックするので、この
-- マイグレーションを適用した直後、バックフィル前でも動作は変わらない。
CREATE TABLE "AiOperationModel" (
    "operation" STRING NOT NULL,
    "modelId" STRING NOT NULL,
    "priceUnits" INT4 NOT NULL,
    "displayName" STRING,
    "sortOrder" INT4 NOT NULL DEFAULT 0,
    "enabled" BOOL NOT NULL DEFAULT true,
    "updatedBy" STRING,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiOperationModel_pkey" PRIMARY KEY ("operation","modelId")
);

-- CockroachDB は新しいテーブルを schema_locked で作るので、索引と外部キーを
-- 足す前に外す必要がある (AiSetting と同じ形)。最後に戻す。
ALTER TABLE "AiOperationModel" SET (schema_locked = false);

-- 一覧は「ある操作の、有効な行を表示順で」しか引かない。
CREATE INDEX "AiOperationModel_operation_enabled_sortOrder_idx"
ON "AiOperationModel"("operation", "enabled", "sortOrder");

CREATE INDEX "AiOperationModel_updatedBy_idx" ON "AiOperationModel"("updatedBy");

ALTER TABLE "AiOperationModel"
ADD CONSTRAINT "AiOperationModel_updatedBy_fkey"
FOREIGN KEY ("updatedBy") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiOperationModel" SET (schema_locked = true);
