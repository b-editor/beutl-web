-- AlterTable
ALTER TABLE "Session" ADD COLUMN "refreshTokenFamilyId" STRING;
ALTER TABLE "Session" ADD COLUMN "refreshTokenConsumedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "refreshTokenReplacedByToken" STRING;
ALTER TABLE "Session" ADD COLUMN "refreshTokenRevokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Session_refreshTokenFamilyId_idx"
ON "Session"("refreshTokenFamilyId");
