-- 完了した Storage アップロードの控え。
--
-- 完了応答だけが失われると、クライアントはファイルができたのかどうか分からない
-- まま同じ id では二度と問い合わせられず、やり直すと同じ内容の二重ファイルが
-- できてしまう。行を消す代わりにここへ結果のファイル id を記録し、同じ id への
-- 再問い合わせにはその結果をそのまま返す。
--
-- 記録済みの行の size は File 側に移っているので、進行中の合計には数えない。
-- 控えそのものは cron の掃除で消える。
ALTER TABLE "StorageUpload" SET (schema_locked = false);

ALTER TABLE "StorageUpload" ADD COLUMN "completedFileId" STRING;

ALTER TABLE "StorageUpload" SET (schema_locked = true);
