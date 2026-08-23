-- 復元の世代。墓標に「どの世代で確認したか」を書き、復元後に全件を見直したことを
-- 時計に頼らず判定する。世代がこのデータベースにあること自体が、確認した相手が
-- 本番であることの裏付けにもなる。
CREATE TABLE IF NOT EXISTS "GitRestoreGeneration" (
    "id" STRING NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitRestoreGeneration_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "GitAccountDeletion" ADD COLUMN IF NOT EXISTS "checkedGeneration" STRING;
