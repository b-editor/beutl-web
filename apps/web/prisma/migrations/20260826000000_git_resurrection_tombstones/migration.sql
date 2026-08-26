-- 失効したトークンと消したリポジトリの墓標。
--
-- どちらも Forgejo 側の操作で完了するが、Forgejo をその前へ戻すと生き返る。
-- 端末に残った平文のトークンや、消したはずのリポジトリが戻ることになる。
-- 戻した後に消し直したことを数えられるよう、消した相手をこちらに残す。
--
-- **足すだけ。** 既存の行には触らない。
CREATE TABLE "GitCredentialRevocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forgejoUsername" TEXT NOT NULL,
    "forgejoTokenId" INTEGER NOT NULL,
    "lastEight" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedGeneration" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "GitCredentialRevocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GitCredentialRevocation_revokedAt_idx" ON "GitCredentialRevocation"("revokedAt");
CREATE INDEX "GitCredentialRevocation_checkedGeneration_idx" ON "GitCredentialRevocation"("checkedGeneration");

CREATE TABLE "GitRepositoryDeletion" (
    "forgejoRepoId" INTEGER NOT NULL,
    "ownerUsername" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedGeneration" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "GitRepositoryDeletion_pkey" PRIMARY KEY ("forgejoRepoId")
);

CREATE INDEX "GitRepositoryDeletion_deletedAt_idx" ON "GitRepositoryDeletion"("deletedAt");
CREATE INDEX "GitRepositoryDeletion_checkedGeneration_idx" ON "GitRepositoryDeletion"("checkedGeneration");
