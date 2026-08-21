-- 20260821070000 を適用済みの環境がありうるので、そちらは書き換えずここで足す。
-- 未適用の環境では 2 つが続けて流れるだけで、結果は同じになる。

-- AlterEnum
ALTER TYPE "GitAccountDeletionPhase" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';

-- AlterTable
-- 既存行があると NOT NULL は直接付けられないので、入れてから制約を足す。
ALTER TABLE "GitAccountDeletion" ADD COLUMN IF NOT EXISTS "intentId" STRING;
UPDATE "GitAccountDeletion" SET "intentId" = gen_random_uuid()::STRING WHERE "intentId" IS NULL;
ALTER TABLE "GitAccountDeletion" ALTER COLUMN "intentId" SET NOT NULL;
