-- CreateTable
CREATE TABLE "RefreshTokenFamily" (
    "id" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefreshTokenFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeRefreshToken" (
    "token" STRING NOT NULL,
    "userId" STRING NOT NULL,
    "refreshTokenFamilyId" STRING NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenConsumedAt" TIMESTAMP(3),
    "refreshTokenReplacedByToken" STRING,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeRefreshToken_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "RefreshTokenFamily_userId_idx"
ON "RefreshTokenFamily"("userId");

-- CreateIndex
CREATE INDEX "RefreshTokenFamily_expiresAt_idx"
ON "RefreshTokenFamily"("expiresAt");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_refreshTokenFamilyId_expiresAt_idx"
ON "NativeRefreshToken"("refreshTokenFamilyId", "expiresAt");

-- CreateIndex
CREATE INDEX "NativeRefreshToken_userId_idx"
ON "NativeRefreshToken"("userId");

-- AddForeignKey
ALTER TABLE "RefreshTokenFamily"
ADD CONSTRAINT "RefreshTokenFamily_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeRefreshToken"
ADD CONSTRAINT "NativeRefreshToken_refreshTokenFamilyId_fkey"
FOREIGN KEY ("refreshTokenFamilyId") REFERENCES "RefreshTokenFamily"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeRefreshToken"
ADD CONSTRAINT "NativeRefreshToken_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "refreshTokenFamilyId";
ALTER TABLE "Session" DROP COLUMN "refreshTokenConsumedAt";
ALTER TABLE "Session" DROP COLUMN "refreshTokenReplacedByToken";
ALTER TABLE "Session" DROP COLUMN "refreshTokenRevokedAt";
