-- これから作るリポジトリの予約。Forgejo を触る前に書く。
-- 名前の重複を Forgejo 上の不在確認だけで判断すると、同じ名前の作成が同時に来た
-- ときに両方が通り、片方が預かり名のまま利用者の手に残る。
CREATE TABLE IF NOT EXISTS "GitRepositoryCreation" (
    "id" STRING NOT NULL,
    "ownerUsername" STRING NOT NULL,
    "name" STRING NOT NULL,
    "holdingName" STRING NOT NULL,
    "forgejoRepoId" INT4,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitRepositoryCreation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GitRepositoryCreation_holdingName_key"
    ON "GitRepositoryCreation"("holdingName");
CREATE UNIQUE INDEX IF NOT EXISTS "GitRepositoryCreation_ownerUsername_name_key"
    ON "GitRepositoryCreation"("ownerUsername", "name");
CREATE INDEX IF NOT EXISTS "GitRepositoryCreation_createdAt_idx"
    ON "GitRepositoryCreation"("createdAt");
