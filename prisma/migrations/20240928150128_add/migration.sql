-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "iconFileId" TEXT;

-- CreateTable
CREATE TABLE "CompatFile" (
    "id" BIGSERIAL NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "CompatFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompatFile_fileId_key" ON "CompatFile"("fileId");

-- AddForeignKey
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_iconFileId_fkey" FOREIGN KEY ("iconFileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompatFile" ADD CONSTRAINT "CompatFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
