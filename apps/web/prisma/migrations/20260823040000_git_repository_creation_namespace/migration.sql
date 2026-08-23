-- 予約の一意性を Forgejo の名前空間に合わせる。
-- Forgejo は UNIQUE(owner_id, lower_name) なので、大文字小文字を区別すると
-- Proj と proj が両方予約でき、片方が預かり名のまま利用者の手に残る。
ALTER TABLE "GitRepositoryCreation" ADD COLUMN IF NOT EXISTS "normalizedName" STRING;
UPDATE "GitRepositoryCreation" SET "normalizedName" = lower("name") WHERE "normalizedName" IS NULL;
ALTER TABLE "GitRepositoryCreation" ALTER COLUMN "normalizedName" SET NOT NULL;

-- 掴んでいる処理と期限。時間だけで古いと決めると、遅い作成を横から回収する。
ALTER TABLE "GitRepositoryCreation" ADD COLUMN IF NOT EXISTS "intentId" STRING;
ALTER TABLE "GitRepositoryCreation" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);

DROP INDEX IF EXISTS "GitRepositoryCreation_ownerUsername_name_key" CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "GitRepositoryCreation_ownerUsername_normalizedName_key"
    ON "GitRepositoryCreation"("ownerUsername", "normalizedName");
DROP INDEX IF EXISTS "GitRepositoryCreation_createdAt_idx" CASCADE;
CREATE INDEX IF NOT EXISTS "GitRepositoryCreation_leaseUntil_idx"
    ON "GitRepositoryCreation"("leaseUntil");
