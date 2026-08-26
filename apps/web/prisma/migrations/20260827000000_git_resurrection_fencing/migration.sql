-- 消去の控えを、1 つのリポジトリ id につき 1 行から**消去 1 回につき 1 行**へ。
--
-- 復元で採番がやり直されると、同じ id を別のリポジトリが持つ。id を主キーにして
-- 上書きしていると、前の相手の「確かめ済み」の控えが消える。その相手が生き返って
-- も誰も追えない。加えて、期限切れの処理が行を読んだ後に前面がやり直すと、古い方が
-- 新しい行を確定させたり消したりできてしまう。1 回ごとの印 (intentId) で条件付ける。
--
-- **表を作り直す。** 主キーが変わるので列を足すだけでは済まない。行は移す。
-- 移した行には「確かめる仕組みが入る前のもの」という印を付ける (消す前に書いて
-- あるだけで、消えたかどうかは分からない)。自動では確定も却下もせず、証拠も
-- 出させない。人が Forgejo 側を確かめて片付ける。
--
-- **この migration を当ててから Worker を入れ替えるまでの間、古い Worker の
-- 削除は失敗する** (forgejoRepoId の一意制約がもう無いため)。失敗する側に倒れる
-- ので、控えの無い削除が起きることはない。
CREATE TABLE "GitRepositoryDeletionNew" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "forgejoRepoId" INTEGER NOT NULL,
    "ownerUsername" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedGeneration" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "baseline" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "GitRepositoryDeletionNew_pkey" PRIMARY KEY ("id")
);

INSERT INTO "GitRepositoryDeletionNew" (
    "id", "intentId", "forgejoRepoId", "ownerUsername", "name",
    "confirmed", "deletedAt", "checkedGeneration", "needsReview", "baseline",
    "attempts", "lastAttemptAt", "lastError"
)
SELECT
    gen_random_uuid()::text,
    gen_random_uuid()::text,
    "forgejoRepoId", "ownerUsername", "name",
    "confirmed", "deletedAt", "checkedGeneration", "needsReview",
    -- 移した行はすべて「確かめる仕組みが入る前のもの」。
    true,
    "attempts", "lastAttemptAt", "lastError"
FROM "GitRepositoryDeletion";

DROP TABLE "GitRepositoryDeletion";
ALTER TABLE "GitRepositoryDeletionNew" RENAME TO "GitRepositoryDeletion";

CREATE INDEX "GitRepositoryDeletion_forgejoRepoId_idx" ON "GitRepositoryDeletion"("forgejoRepoId");
CREATE INDEX "GitRepositoryDeletion_deletedAt_idx" ON "GitRepositoryDeletion"("deletedAt");
CREATE INDEX "GitRepositoryDeletion_checkedGeneration_idx" ON "GitRepositoryDeletion"("checkedGeneration");

-- 失効の控えも同じ扱い。こちらは主キーが既に 1 回ごとなので、印を足すだけ。
ALTER TABLE "GitCredentialRevocation" ADD COLUMN "baseline" BOOLEAN NOT NULL DEFAULT false;
UPDATE "GitCredentialRevocation" SET "baseline" = true;

-- 刈った線。ここより古い控えはもう消えているので、そこから戻しても数に出ない。
ALTER TABLE "GitResurrectionWatch" ADD COLUMN "prunedBefore" TIMESTAMP(3);

-- 戻した控えを**中身**で縛る。名前だけだと、古い控えを新しい名前に付け替えるだけで
-- 通る。版も控えて、古い版で登録した世代を新しい版で使い回せないようにする。
ALTER TABLE "GitRestoreGeneration" ADD COLUMN "dbDigest" TEXT;
ALTER TABLE "GitRestoreGeneration" ADD COLUMN "dataDigest" TEXT;
ALTER TABLE "GitRestoreGeneration" ADD COLUMN "protocol" TEXT;

-- 予約の片付けが次にどこから読むか。Worker の記憶に置くと isolate が
-- 入れ替わるたびに消え、飛ばす行が先頭に並んだままだと同じところで止まり続ける。
CREATE TABLE "GitReconcileCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "after" TEXT,

    CONSTRAINT "GitReconcileCursor_pkey" PRIMARY KEY ("id")
);
INSERT INTO "GitReconcileCursor" ("id", "after") VALUES ('singleton', NULL);
