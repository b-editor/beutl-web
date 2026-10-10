-- 掃除が「この行のパートは自分が捨てる」と宣言した時刻。
--
-- 一覧を引いてから順番が回ってくるまでの間に、そのアップロードが完了している
-- ことがある。読み直すだけでは足りない——読んだ直後に完了されると、File が指す
-- ことになるオブジェクトを消してしまう。宣言できた行にはもう控えを書けないので、
-- そのあと中止してもオブジェクトを消しても、File が消えたものを指すことはない。
--
-- 宣言済みの行は同時実行の本数には数えないが、容量には数える——中止に失敗して
-- いるあいだ、そのパートは本当にバケットにある。
--
-- この移行は一度、ロック解除を書かないまま置かれていた。CockroachDB は新しい
-- テーブルを schema_locked で作るので、その形では必ず失敗する——適用に成功した
-- 環境は無い。失敗した記録が残っている環境では、
--   npx prisma migrate resolve --rolled-back 20260821120000_add_storage_upload_abandoned_at
-- を実行してから、もう一度適用すること。
ALTER TABLE "StorageUpload" SET (schema_locked = false);

ALTER TABLE "StorageUpload" ADD COLUMN "abandonedAt" TIMESTAMP(3);

ALTER TABLE "StorageUpload" SET (schema_locked = true);
