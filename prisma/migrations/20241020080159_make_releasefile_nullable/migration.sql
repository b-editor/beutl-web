-- DropForeignKey
ALTER TABLE "Release" DROP CONSTRAINT "Release_fileId_fkey";

-- AlterTable
ALTER TABLE "Release" ALTER COLUMN "fileId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
