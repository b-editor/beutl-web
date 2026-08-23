-- 予約が何をしている最中のものかを持つ。
-- CREATE は預かりものを渡し切る、RENAME は名前が変わったかを確かめるだけ。
-- 混ぜると、改名の後始末のつもりで利用者が編集した .gitattributes を直しにいく。
CREATE TYPE "GitRepositoryOperation" AS ENUM ('CREATE', 'RENAME');

ALTER TABLE "GitRepositoryCreation"
    ADD COLUMN IF NOT EXISTS "operation" "GitRepositoryOperation" NOT NULL DEFAULT 'CREATE';
ALTER TABLE "GitRepositoryCreation" ADD COLUMN IF NOT EXISTS "sourceName" STRING;
