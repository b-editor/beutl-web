-- ストレージ画面のフォルダー。ユーザーがファイルを整理するための入れ物で、R2 の
-- キーとは無関係。ツリーは親への参照だけで持つ。
--
-- フォルダー行が消えても File 行を道連れにしない (R2 のオブジェクトが漏れる)。
-- ファイル側は参照を落とすだけにし、中身の削除はアプリがストレージの後始末付きで
-- 先に行う。Cockroach のローリングデプロイに備えて前進のみ・再実行可能に書く。
CREATE TABLE IF NOT EXISTS "StorageFolder" (
    "id" STRING NOT NULL,
    "name" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "parentId" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageFolder_pkey" PRIMARY KEY ("id")
);

-- CockroachDB は新しいテーブルを schema_locked で作るので、索引と外部キーを
-- 足す前に外す。
ALTER TABLE "StorageFolder" SET (schema_locked = false);

-- 一覧は「このユーザーの、この親の下」で引く。
CREATE INDEX IF NOT EXISTS "StorageFolder_userId_parentId_idx" ON "StorageFolder"("userId", "parentId");

ALTER TABLE "StorageFolder"
ADD CONSTRAINT IF NOT EXISTS "StorageFolder_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- 親が消えれば子フォルダーも消える。ファイルは下の SET NULL でルートに戻る。
ALTER TABLE "StorageFolder"
ADD CONSTRAINT IF NOT EXISTS "StorageFolder_parentId_fkey"
FOREIGN KEY ("parentId") REFERENCES "StorageFolder"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "File" SET (schema_locked = false);
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "folderId" STRING;
CREATE INDEX IF NOT EXISTS "File_folderId_idx" ON "File"("folderId");

ALTER TABLE "File"
ADD CONSTRAINT IF NOT EXISTS "File_folderId_fkey"
FOREIGN KEY ("folderId") REFERENCES "StorageFolder"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
