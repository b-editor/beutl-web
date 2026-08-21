-- テンプレートを入れ切れなかったリポジトリを片付くまで控える。
-- 相手は Forgejo のリポジトリ id。名前は改名で変わり、空いた名前を別のリポジトリが
-- 取ることがあるので、名前で引き直すと別物を止めてしまう。
CREATE TABLE IF NOT EXISTS "GitRepositoryRepair" (
    "forgejoRepoId" INT4 NOT NULL,
    "ownerUsername" STRING NOT NULL,
    "name" STRING NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INT4 NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" STRING,

    CONSTRAINT "GitRepositoryRepair_pkey" PRIMARY KEY ("forgejoRepoId")
);

CREATE INDEX IF NOT EXISTS "GitRepositoryRepair_lastAttemptAt_idx"
    ON "GitRepositoryRepair"("lastAttemptAt");
