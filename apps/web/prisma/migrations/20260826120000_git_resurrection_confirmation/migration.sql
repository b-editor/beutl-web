-- 控えを「消す前に書く」ことと、「控えがある = 消えた」ことは別。
--
-- 消す前に書かないと、書いた後に落ちたものを追えない。しかし書いただけのものを
-- 消し直しの対象にすると、403 や 422 で断られた削除を定期実行が後から実行して
-- しまう。利用者が消せなかったリポジトリを、15 分後に定期実行が消すことになる。
-- 確かめた印を分けて持つ。
--
-- **足すだけ。** 既存の行には触らない。
ALTER TABLE "GitCredentialRevocation" ADD COLUMN "credentialId" TEXT;
ALTER TABLE "GitCredentialRevocation" ADD COLUMN "confirmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GitRepositoryDeletion" ADD COLUMN "confirmed" BOOLEAN NOT NULL DEFAULT false;

-- 直しが読み取り専用を掛けたかどうか。遅れて着地したコミットで既定値が揃った
-- ときに、掛けたものを外してから片付けるために要る。
ALTER TABLE "GitRepositoryRepair" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;

-- 戻した控えの時点。見張りの開始より古ければ証拠を出さない。
ALTER TABLE "GitRestoreGeneration" ADD COLUMN "backupAt" TIMESTAMP(3);

-- 見張りを始めた時点。**1 行だけ。**
--
-- ここでは NULL で作る。マイグレーションを当てた時点を入れてしまうと、3 つの
-- Worker を入れ替え終わるまでの間に古い Worker が控えを書かずに消したものを、
-- 見張っているつもりになる。実際に入れるのは配備の最後 (scripts/release.mjs)。
CREATE TABLE "GitResurrectionWatch" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "GitResurrectionWatch_pkey" PRIMARY KEY ("id")
);
INSERT INTO "GitResurrectionWatch" ("id", "startedAt") VALUES ('singleton', NULL);
