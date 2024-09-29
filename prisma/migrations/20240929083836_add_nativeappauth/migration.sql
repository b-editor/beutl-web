/*
  Warnings:

  - You are about to drop the column `sha256` on the `File` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "File" DROP COLUMN "sha256",
ALTER COLUMN "size" SET DATA TYPE BIGINT;

-- CreateTable
CREATE TABLE "NativeAppAuth" (
    "id" TEXT NOT NULL,
    "continueUrl" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "code" TEXT,
    "codeExpires" TIMESTAMP(3),

    CONSTRAINT "NativeAppAuth_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "NativeAppAuth" ADD CONSTRAINT "NativeAppAuth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
