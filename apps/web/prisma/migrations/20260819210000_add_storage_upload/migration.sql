-- 進行中のアップロードを表す行。
--
-- Cloudflare Workers はリクエストボディを 100MB で打ち切るため、それより大きな
-- ファイルは複数のリクエストに分けて送り、R2 のマルチパートアップロードとして
-- バケット側で組み立てる。その間の「どのキーの、どのアップロードか」をここに置く。
--
-- クライアントから受け取ったキーや uploadId を信用しないためでもある。両方を
-- 知っていれば他人のファイルにパートを足せてしまうので、id と userId で引ける
-- この行だけを根拠にする。
--
-- 完了・中止で消える。放置されたものは cron が中止して消す。未完了の
-- マルチパートアップロードはパートを保持し続け、その分の保管料がかかるため。
CREATE TABLE "StorageUpload" (
    "id" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "objectKey" STRING NOT NULL,
    "uploadId" STRING NOT NULL,
    "name" STRING NOT NULL,
    "mimeType" STRING NOT NULL,
    "size" INT8 NOT NULL,
    "partSize" INT4 NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageUpload_pkey" PRIMARY KEY ("id")
);

-- CockroachDB は新しいテーブルを schema_locked で作るので、索引と外部キーを
-- 足す前に外す。最後に戻す。
ALTER TABLE "StorageUpload" SET (schema_locked = false);

CREATE INDEX "StorageUpload_userId_idx" ON "StorageUpload"("userId");

-- 放置されたアップロードの掃除は古い順に引く。
CREATE INDEX "StorageUpload_createdAt_idx" ON "StorageUpload"("createdAt");

ALTER TABLE "StorageUpload"
ADD CONSTRAINT "StorageUpload_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorageUpload" SET (schema_locked = true);
