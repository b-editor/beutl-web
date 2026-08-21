-- 消し終えた退会を墓標として残す。
-- Forgejo だけを退会前の時点に戻すとユーザーとトークンが復活するが、beutl-web 側に
-- 利用者も行も残っていなければ誰も気付けない。消した相手を控え続けて照合する。
ALTER TYPE "GitAccountDeletionPhase" ADD VALUE IF NOT EXISTS 'PURGED';
ALTER TABLE "GitAccountDeletion" ADD COLUMN IF NOT EXISTS "purgedAt" TIMESTAMP(3);
