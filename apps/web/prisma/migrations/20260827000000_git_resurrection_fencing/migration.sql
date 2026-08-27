-- 消去の控えを、1 つのリポジトリ id につき 1 行から**消去 1 回につき 1 行**へ。
--
-- 復元で採番がやり直されると、同じ id を別のリポジトリが持つ。id を主キーにして
-- 上書きしていると、前の相手の「確かめ済み」の控えが消える。その相手が生き返って
-- も誰も追えない。加えて、期限切れの処理が行を読んだ後に前面がやり直すと、古い方が
-- 新しい行を確定させたり消したりできてしまう。1 回ごとの印 (intentId) で条件付ける。
--
-- **古い表は落とさない。**
--
-- 新しい表へ写して古い方を落とすと、この migration を当てている最中に古い Worker が
-- 書いた行が消える。消えた行の相手は「消したのに控えの無いリポジトリ」になり、
-- 復元で生き返っても誰も追えない。migration を当てた後に古い Worker の削除が失敗
-- するようにしても、当てている最中の窓は閉じない。
--
-- そこで表を増やすだけにする。定期実行が古い表に残った行を拾って新しい表へ移し、
-- 空になったことを確かめてから、後の migration で落とす。
CREATE TABLE "GitRepositoryDeletionRecord" (
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

    CONSTRAINT "GitRepositoryDeletionRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GitRepositoryDeletionRecord_forgejoRepoId_idx" ON "GitRepositoryDeletionRecord"("forgejoRepoId");
CREATE INDEX "GitRepositoryDeletionRecord_deletedAt_idx" ON "GitRepositoryDeletionRecord"("deletedAt");
CREATE INDEX "GitRepositoryDeletionRecord_checkedGeneration_idx" ON "GitRepositoryDeletionRecord"("checkedGeneration");

-- 失効の控えも同じ扱い。こちらは主キーが既に 1 回ごとなので、印を足すだけ。
--
-- 確かめる仕組みが入る前の行は、消す前に書いてあるだけで、消えたかどうかは
-- 分からない。自動では確定も却下もせず (却下すると、復元で生き返ったものを
-- 追えなくなる)、証拠も出させない。人が Forgejo 側を確かめて片付ける。
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
