-- 管理画面がストア間 (R2 / S3) でオブジェクトを移す間だけ File 行に持つリース。
-- isolate を跨いで同じファイルの移動が同時に走り、互いのコピーを消し合わないよう
-- にする。期限切れのリースは取り直せる。Cockroach のローリングデプロイに備えて
-- 前進のみ・再実行可能に書き、schema_locked を前後で外し直す。
ALTER TABLE "File" SET (schema_locked = false);
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "storageMoveLeaseToken" STRING;
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "storageMoveLeaseUntil" TIMESTAMP(3);
ALTER TABLE "File" SET (schema_locked = true);
